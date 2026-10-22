import { normalizeToken } from "./feed-normalization.util";
/**
 * Signal calculation.
 *
 * Turns a set of candidate post ids into a fully populated `FeedSignals` vector
 * per candidate, using a fixed number of batched queries regardless of how many
 * candidates there are. Nothing in this file issues a query inside a loop.
 *
 * Query budget (all run concurrently):
 *   1. post rows (also the second, authoritative privacy check)
 *   2. author profiles + follower counts + premium visibility
 *   3. this viewer's impressions on these posts
 *   4. this viewer's per-creator impression/engagement behaviour
 *   5. platform-level daily stats for these posts
 *   6. rolling-window engagement + lifetime saves for these posts
 */

import { Prisma } from '@prisma/client';
import { prismaRead } from '../../../../config/prisma';
import { buildPostVisibilityWhere } from '../../../../shared/utils/access-control.util';
import { getPostMetadata } from '../../../content/utils/post.util';
import { getFeedConfig, type FeedConfig } from './feed-config';
import { engagementQuality, engagementVelocity } from './engagement-scorer.service';
import { relationshipStrength, saturate, sharedRatio } from './relationship-scorer.service';
import type { FeedAuthorProfile, FeedCandidate, FeedCreatorBehaviour, FeedPostStats, FeedScoringPost, FeedSeenRecord, FeedSignals, FeedViewerContext } from './feed-types';

const CREATOR_BEHAVIOUR_LOOKBACK_DAYS = 30;

export interface SignalBundle {
  posts: Map<string, FeedScoringPost>;
  authors: Map<string, FeedAuthorProfile>;
  seen: Map<string, FeedSeenRecord>;
  creatorBehaviour: Map<string, FeedCreatorBehaviour>;
  stats: Map<string, FeedPostStats>;
  /** Posts per author inside the burst window, for anti-spam demotion. */
  authorPostCounts: Map<string, number>;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}



/**
 * Searchable text for a post, used for topical affinity.
 *
 * Includes the author's own profile fields because on Vormex "who wrote it" is
 * part of what makes a post relevant — a post from a CS student at your college
 * is topically closer to you than the same words from a stranger.
 */
export function postSearchText(post: FeedScoringPost, author?: FeedAuthorProfile): string {
  const metadata = getPostMetadata(post.metadata);
  return [
    post.content,
    post.type,
    author?.college,
    author?.branch,
    author?.degree,
    metadata.articleTitle,
    ...(metadata.articleTags || []),
    metadata.linkTitle,
    metadata.linkDescription,
    metadata.documentName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Coarse topic keys for diversity re-ranking (not for scoring). */
export function postTopics(post: FeedScoringPost, author?: FeedAuthorProfile): string[] {
  const metadata = getPostMetadata(post.metadata);
  const tags = (metadata.articleTags || [])
    .map(normalizeToken)
    .filter((token): token is string => Boolean(token))
    .slice(0, 5);

  const type = normalizeToken(post.type);
  const college = normalizeToken(author?.college);

  return Array.from(new Set([...tags, ...(type ? [`type:${type}`] : []), ...(college ? [`college:${college}`] : [])]));
}

/**
 * Fraction of the viewer's tokens present in the text.
 *
 * A ratio rather than a count, so a viewer with 40 interests does not out-score
 * one with 4 on every single post.
 */
function tokenOverlapRatio(text: string, tokens: string[]): number {
  if (!text || tokens.length === 0) return 0;

  let matches = 0;
  for (const token of tokens) {
    // Short tokens ("ai", "ml", "go") need word boundaries or they match inside
    // unrelated words and every post looks relevant.
    const isMatch = token.length <= 3
      ? new RegExp(`(?<![a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(text)
      : text.includes(token);
    if (isMatch) matches += 1;
  }

  if (matches === 0) return 0;
  // Saturates at ~4 matches: beyond that the post is simply "on topic".
  return Math.min(1, matches / Math.min(4, tokens.length));
}

function contentCompleteness(post: FeedScoringPost): number {
  const metadata = getPostMetadata(post.metadata);
  const mediaUrls = Array.isArray(post.mediaUrls) ? post.mediaUrls.filter(Boolean) : [];
  const type = String(post.type || '').toLowerCase();

  let score = 0;
  if (String(post.content || '').trim().length >= 40) score += 0.3;
  if (mediaUrls.length > 0) score += 0.25;
  if (metadata.videoUrl || metadata.defaultVideoId || type === 'video') score += 0.2;
  if (metadata.documentUrl || type === 'document') score += 0.15;
  if ((metadata.pollOptions || []).length > 0 || type === 'poll') score += 0.15;
  if (metadata.articleTitle || type === 'article') score += 0.2;
  if (metadata.linkUrl || type === 'link') score += 0.1;
  return Math.min(1, score);
}

/** Exponential freshness decay. Never a plain `ORDER BY createdAt DESC`. */
export function freshness(ageHours: number, halfLifeHours: number): number {
  const safeAge = Math.max(0, ageHours);
  return Math.pow(0.5, safeAge / Math.max(0.5, halfLifeHours));
}

/**
 * Loads every batched signal input.
 *
 * `buildPostVisibilityWhere` is applied here, so this is also the authoritative
 * privacy gate: a candidate the viewer may not access simply does not come back
 * and therefore cannot be ranked.
 */
export async function loadSignalInputs(input: {
  userId: string;
  candidates: FeedCandidate[];
  nowMs: number;
  config?: FeedConfig;
}): Promise<SignalBundle> {
  const config = input.config || getFeedConfig();
  const postIds = input.candidates.map((candidate) => candidate.postId);
  const authorIds = Array.from(new Set(input.candidates.map((candidate) => candidate.authorId)));

  const empty: SignalBundle = {
    posts: new Map(),
    authors: new Map(),
    seen: new Map(),
    creatorBehaviour: new Map(),
    stats: new Map(),
    authorPostCounts: new Map(),
  };
  if (postIds.length === 0) return empty;

  const seenSince = new Date(input.nowMs - config.seen.lookbackDays * 86_400_000);
  const behaviourSince = new Date(input.nowMs - CREATOR_BEHAVIOUR_LOOKBACK_DAYS * 86_400_000);
  const velocitySince = new Date(input.nowMs - config.engagement.velocityWindowHours * 3_600_000);
  const burstSince = new Date(input.nowMs - config.antiGaming.authorBurstWindowHours * 3_600_000);

  const visibilityWhere = await buildPostVisibilityWhere(input.userId);

  const [postRows, authorRows, statRows, seenRows, behaviourRows, engagementRows, burstRows] =
    await Promise.all([
      prismaRead.post.findMany({
        where: { id: { in: postIds }, isActive: true, ...visibilityWhere },
        select: {
          id: true,
          authorId: true,
          content: true,
          type: true,
          visibility: true,
          mediaUrls: true,
          metadata: true,
          likesCount: true,
          commentsCount: true,
          sharesCount: true,
          createdAt: true,
          updatedAt: true,
        },
      }),

      prismaRead.user.findMany({
        where: { id: { in: authorIds } },
        select: {
          id: true,
          college: true,
          branch: true,
          degree: true,
          graduationYear: true,
          interests: true,
          isBanned: true,
          createdAt: true,
          userStats: { select: { followersCount: true } },
        },
      }),

      prismaRead.$queryRaw<Array<{ entityId: string; impressions: number; positives: number; negatives: number }>>(
        Prisma.sql`
          SELECT "entityId",
                 SUM("organicImpressions")::int AS impressions,
                 SUM("organicQualifiedPositives")::int AS positives,
                 SUM("organicNegativeFeedback")::int AS negatives
          FROM "recommendation_item_daily_stats"
          WHERE "entityType" = 'POST'
            AND "entityId" IN (${Prisma.join(postIds)})
            AND "day" >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY "entityId"
        `
      ).catch(() => []),

      prismaRead.$queryRaw<Array<{ postId: string; seenAt: Date; seenCount: number; dwellMs: number | null }>>(
        Prisma.sql`
          SELECT "postId", "seenAt", "seenCount", "dwellMs"
          FROM "feed_impressions"
          WHERE "userId" = ${input.userId}
            AND "postId" IN (${Prisma.join(postIds)})
            AND "seenAt" >= ${seenSince}
        `
      ).catch(() => []),

      // Per-creator behaviour for this viewer: how often their posts were shown
      // and how often the viewer actually did something about it.
      prismaRead.$queryRaw<Array<{ creatorId: string; impressions: number; engagements: number; avgDwellMs: number }>>(
        Prisma.sql`
          SELECT fi."creatorId",
                 COUNT(*)::int AS impressions,
                 COUNT(l."userId")::int AS engagements,
                 COALESCE(AVG(NULLIF(fi."dwellMs", 0)), 0)::float AS "avgDwellMs"
          FROM "feed_impressions" fi
          LEFT JOIN "post_likes" l ON l."postId" = fi."postId" AND l."userId" = fi."userId"
          WHERE fi."userId" = ${input.userId}
            AND fi."creatorId" IS NOT NULL
            AND fi."seenAt" >= ${behaviourSince}
          GROUP BY fi."creatorId"
        `
      ).catch(() => []),

      // Rolling-window engagement plus lifetime saves, in one pass.
      prismaRead.$queryRaw<Array<{
        postId: string;
        recentLikes: number;
        recentComments: number;
        recentSaves: number;
        totalSaves: number;
      }>>(
        // Only posts with at least one counted interaction come back; the caller
        // defaults everything else to zero, so the driving set is the union of
        // the aggregates rather than an materialised candidate list.
        Prisma.sql`
          WITH "recent_likes" AS (
            SELECT "postId", COUNT(DISTINCT "userId")::int AS "actors"
            FROM "post_likes"
            WHERE "postId" IN (${Prisma.join(postIds)}) AND "createdAt" >= ${velocitySince}
            GROUP BY "postId"
          ),
          "recent_comments" AS (
            SELECT "postId", COUNT(DISTINCT "authorId")::int AS "actors"
            FROM "post_comments"
            WHERE "postId" IN (${Prisma.join(postIds)}) AND "createdAt" >= ${velocitySince}
            GROUP BY "postId"
          ),
          "recent_saves" AS (
            SELECT "postId", COUNT(DISTINCT "userId")::int AS "actors"
            FROM "saved_posts"
            WHERE "postId" IN (${Prisma.join(postIds)}) AND "createdAt" >= ${velocitySince}
            GROUP BY "postId"
          ),
          "total_saves" AS (
            SELECT "postId", COUNT(*)::int AS "total"
            FROM "saved_posts"
            WHERE "postId" IN (${Prisma.join(postIds)})
            GROUP BY "postId"
          ),
          "engaged_ids" AS (
            SELECT "postId" FROM "recent_likes"
            UNION SELECT "postId" FROM "recent_comments"
            UNION SELECT "postId" FROM "recent_saves"
            UNION SELECT "postId" FROM "total_saves"
          )
          SELECT e."postId",
                 COALESCE(rl."actors", 0) AS "recentLikes",
                 COALESCE(rc."actors", 0) AS "recentComments",
                 COALESCE(rs."actors", 0) AS "recentSaves",
                 COALESCE(ts."total", 0) AS "totalSaves"
          FROM "engaged_ids" e
          LEFT JOIN "recent_likes" rl ON rl."postId" = e."postId"
          LEFT JOIN "recent_comments" rc ON rc."postId" = e."postId"
          LEFT JOIN "recent_saves" rs ON rs."postId" = e."postId"
          LEFT JOIN "total_saves" ts ON ts."postId" = e."postId"
        `
      ).catch(() => []),

      prismaRead.$queryRaw<Array<{ authorId: string; posts: number }>>(Prisma.sql`
        SELECT "authorId", COUNT(*)::int AS posts
        FROM "posts"
        WHERE "authorId" IN (${Prisma.join(authorIds)})
          AND "isActive" = true
          AND "createdAt" >= ${burstSince}
        GROUP BY "authorId"
      `).catch(() => []),
    ]);

  const posts = new Map<string, FeedScoringPost>(
    postRows.map((row): [string, FeedScoringPost] => [
      row.id,
      {
        id: row.id,
        authorId: row.authorId,
        content: row.content ?? '',
        type: row.type ?? 'text',
        visibility: row.visibility ?? 'public',
        mediaUrls: Array.isArray(row.mediaUrls) ? row.mediaUrls : [],
        metadata: row.metadata,
        likesCount: number(row.likesCount),
        commentsCount: number(row.commentsCount),
        sharesCount: number(row.sharesCount),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ])
  );

  const authors = new Map<string, FeedAuthorProfile>(
    authorRows.map((row): [string, FeedAuthorProfile] => [
      row.id,
      {
        id: row.id,
        college: row.college ?? null,
        branch: row.branch ?? null,
        degree: row.degree ?? null,
        graduationYear: row.graduationYear ?? null,
        interests: Array.isArray(row.interests) ? row.interests : [],
        isBanned: Boolean(row.isBanned),
        createdAt: row.createdAt,
        followersCount: number(row.userStats?.followersCount),
        // Premium presentation is applied by the existing visibility service at
        // hydration; ranking only needs a tiny, capped tie-break.
        isPremium: false,
        profileBoostActive: false,
      },
    ])
  );

  type EngagementRow = (typeof engagementRows)[number];
  type StatRow = (typeof statRows)[number];

  const engagementByPost = new Map<string, EngagementRow>(
    engagementRows.map((row): [string, EngagementRow] => [String(row.postId), row])
  );

  const stats = new Map<string, FeedPostStats>();
  const statById = new Map<string, StatRow>(
    statRows.map((row): [string, StatRow] => [String(row.entityId), row])
  );
  for (const postId of postIds) {
    const post = posts.get(postId);
    const platform = statById.get(postId);
    const engagement = engagementByPost.get(postId);
    const w = config.engagement.weights;

    stats.set(postId, {
      impressions: number(platform?.impressions),
      positives: number(platform?.positives),
      negatives: number(platform?.negatives),
      // Likes and saves are unique per user by schema constraint, so their sum
      // is a sound lower bound on distinct engagers.
      uniqueEngagers: number(post?.likesCount) + number(engagement?.totalSaves),
      recentEngagement:
        number(engagement?.recentLikes) * w.like +
        number(engagement?.recentComments) * w.comment +
        number(engagement?.recentSaves) * w.save,
    });
  }

  const seen = new Map<string, FeedSeenRecord>(
    seenRows.map((row): [string, FeedSeenRecord] => [
      String(row.postId),
      { seenAt: new Date(row.seenAt), seenCount: Math.max(1, number(row.seenCount)), dwellMs: row.dwellMs ?? null },
    ])
  );

  const creatorBehaviour = new Map<string, FeedCreatorBehaviour>(
    behaviourRows.map((row): [string, FeedCreatorBehaviour] => {
      const impressions = Math.max(0, number(row.impressions));
      const engagements = Math.max(0, number(row.engagements));
      return [
        String(row.creatorId),
        {
          impressions,
          engagements,
          averageDwellMs: number(row.avgDwellMs),
          skipRatio: impressions > 0 ? 1 - Math.min(1, engagements / impressions) : 0,
        },
      ];
    })
  );

  const authorPostCounts = new Map<string, number>(
    burstRows.map((row): [string, number] => [String(row.authorId), number(row.posts)])
  );

  // Saves live only in the engagement query; fold them into the post rows so the
  // ranker sees one consistent view of a post's counters.
  for (const [postId, post] of posts) {
    const engagement = engagementByPost.get(postId);
    (post as FeedScoringPost & { savesCount: number }).savesCount = number(engagement?.totalSaves);
  }

  return { posts, authors, seen, creatorBehaviour, stats, authorPostCounts };
}

/** Builds the signal vector for one candidate. Pure — safe to unit test. */
export function computeSignals(input: {
  candidate: FeedCandidate;
  post: FeedScoringPost;
  author: FeedAuthorProfile | undefined;
  viewer: FeedViewerContext;
  seen: FeedSeenRecord | undefined;
  behaviour: FeedCreatorBehaviour | undefined;
  stats: FeedPostStats | undefined;
  authorRecentPostCount: number;
  nowMs: number;
  config: FeedConfig;
}): FeedSignals {
  const { candidate, post, author, viewer, seen, behaviour, stats, config } = input;
  const authorId = candidate.authorId;

  const ageHours = Math.max(0, input.nowMs - new Date(post.createdAt).getTime()) / 3_600_000;

  const isFollowing = viewer.followingIds.includes(authorId);
  const isConnection = viewer.connectionIds.includes(authorId);
  const isRecentConnection = viewer.recentConnectionIds.includes(authorId);
  const isMutualFollow = viewer.mutualFollowIds.includes(authorId);
  const isSecondDegree = !isFollowing && !isConnection && viewer.secondDegreeIds.includes(authorId);

  const sameCollege = Boolean(viewer.college && author?.college && viewer.college === author.college);
  const sameCourse = Boolean(
    (viewer.branch && author?.branch && viewer.branch === author.branch) ||
      (viewer.degree && author?.degree && viewer.degree === author.degree)
  );
  const sameYear = Boolean(
    viewer.graduationYear && author?.graduationYear && viewer.graduationYear === author.graduationYear
  );

  const authorInterestTokens = (author?.interests || [])
    .map(normalizeToken)
    .filter((token): token is string => Boolean(token));
  const sharedInterestCount = authorInterestTokens.filter((token) =>
    viewer.interestTokens.includes(token)
  ).length;

  const searchText = postSearchText(post, author);
  const sharedInterests = Math.max(
    sharedRatio(sharedInterestCount, viewer.interestTokens.length),
    tokenOverlapRatio(searchText, viewer.interestTokens)
  );
  const sharedSkills = tokenOverlapRatio(searchText, viewer.skillTokens);
  const contentAffinity = Math.max(
    sharedSkills,
    sharedInterests,
    tokenOverlapRatio(searchText, viewer.educationTokens) * 0.6
  );

  const savesCount = number((post as FeedScoringPost & { savesCount?: number }).savesCount);

  const strength = relationshipStrength(
    {
      isFollowing,
      isFollowedBy: isMutualFollow,
      isConnection,
      isRecentConnection,
      messagesCount: viewer.messageCounts[authorId] || 0,
      // Creator/profile affinity are already recency-weighted 0..1 scores; the
      // saturation curve expects counts, so scale them back to that domain.
      commentsBetweenUsers: (viewer.creatorAffinity[authorId] || 0) * config.relationship.saturation.comments,
      likesBetweenUsers: (viewer.creatorAffinity[authorId] || 0) * config.relationship.saturation.likes,
      profileVisits: (viewer.profileVisitAffinity[authorId] || 0) * config.relationship.saturation.profileVisits,
      sameCollege,
      sharedInterestsCount: sharedInterestCount,
      sharedSkillsCount: Math.round(sharedSkills * 4),
      viewerInterestsCount: viewer.interestTokens.length,
      viewerSkillsCount: viewer.skillTokens.length,
    },
    config.relationship
  );

  const impressions = number(stats?.impressions);
  const quality = engagementQuality(
    {
      likes: post.likesCount,
      comments: post.commentsCount,
      shares: post.sharesCount,
      saves: savesCount,
      impressions,
      uniqueEngagers: stats?.uniqueEngagers,
    },
    config.engagement
  );

  const velocity = engagementVelocity(
    { recentEngagement: stats?.recentEngagement, ageHours },
    config.engagement
  );

  const isNewPost = ageHours <= config.freshness.newPostHours;
  const isNewCreator =
    (author?.followersCount ?? 0) <= config.exploration.smallCreatorFollowerCeiling &&
    !isFollowing &&
    !isConnection;

  const negativeFeedbackRate = impressions > 0 ? number(stats?.negatives) / impressions : 0;

  const skipRatio = behaviour?.skipRatio ?? 0;
  const creatorSkipped =
    (behaviour?.impressions ?? 0) >= config.antiGaming.creatorSkipMinimumImpressions &&
    skipRatio >= config.antiGaming.creatorSkipRatio;

  // Dwell is one signal among many and is deliberately only used as a mild
  // negative: a long dwell can mean "engrossed" or "walked away from the phone",
  // so it never earns a boost here.
  const lowDwell = Boolean(
    behaviour && behaviour.impressions >= 5 && behaviour.averageDwellMs > 0 && behaviour.averageDwellMs < 800
  );

  return {
    isFollowing,
    isConnection,
    isRecentConnection,
    isMutualFollow,
    isSecondDegree,
    relationshipStrength: strength,

    sameCollege,
    sameCourse,
    sameYear,
    sharedInterests,
    sharedSkills,

    creatorAffinity: Math.min(
      1,
      (viewer.creatorAffinity[authorId] || 0) + 0.35 * (viewer.profileVisitAffinity[authorId] || 0)
    ),
    contentAffinity,
    cohortProof: saturate(number(candidate.sourceScores.COHORT_POPULAR), 5),

    freshness: freshness(ageHours, config.freshness.halfLifeHours),
    ageHours,
    engagementQuality: quality,
    engagementVelocity: velocity,
    contentCompleteness: contentCompleteness(post),
    premiumTieBreak: 0,

    isNewPost,
    isNewCreator,
    explorationEligible: impressions <= config.exploration.newPostImpressionCeiling,

    seenAt: seen?.seenAt ?? null,
    seenCount: seen?.seenCount ?? 0,
    lowDwell,
    creatorSkipped,
    negativeFeedbackRate,
    authorBurst: input.authorRecentPostCount > config.antiGaming.authorBurstThreshold,
  };
}
