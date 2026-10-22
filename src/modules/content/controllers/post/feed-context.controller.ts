import { selectManagedAdPlacements } from "../../../ads/services/managed-ad.service";
import { getQueue } from "../../../../infrastructure/queue/queues";
import { queueNames } from "../../../../infrastructure/queue/queue-names";
import { logger } from "../../../../infrastructure/logging/logger";
import { Request, Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { normalizeImpressionPayload, writeFeedImpressions, type BuildFeedOutput, buildFeedDebugEntries } from "../../../discovery/services/feed/index";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { type FeedRecommendationProfileInput, buildFeedRecommendationProfile } from "../../../discovery/services/feed-algorithm.service";
import { prismaRead, JOIN_RELATIONS } from "../../../../config/prisma";
import { type RecommendationSnapshotItem } from "../../../discovery/services/recommendation-platform.service";
import { buildPostVisibilityWhere } from "../../../../shared/utils/access-control.util";
import { attachReactionSummaries, mapPostResponse } from "../../utils/post.util";
import { getPremiumVisibilityByUserIds, applyPremiumVisibilityToUser } from "../../../premium/services/premium-visibility.service";
import { feedCacheTags, AuthRequest, RECENT_PROFILE_LOOKBACK_MS, MAX_RECENT_PROFILE_SIGNALS, compactStringList, connectionPeerIds, recentProfileWeights, postResponseInclude } from "./support.controller";

export const FEED_IMPRESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export /*
 * How often the ranked first page is recomputed.
 *
 * The window is part of the feed cache key, so it is also the rotation cadence:
 * inside one window every reload replays the byte-identical ranked page, and a
 * new window re-ranks with the viewer's latest impressions applied. This was
 * 24 hours, which is why the home feed served the same posts in the same order
 * all day no matter how many times it was reloaded.
 */
const HOME_FEED_SNAPSHOT_WINDOW_MS = Math.max(
  15_000,
  Number(process.env.HOME_FEED_SNAPSHOT_WINDOW_MS) || 60_000
);

export // Only has to outlive the window it keys. A long TTL just pins dead snapshots
// in Redis, one per user per window.
const HOME_FEED_CACHE_TTL_SECONDS = 5 * 60;

export /*
 * Deliberately independent of the page cache above: this bounds how long a
 * pagination cursor stays resolvable. Tying it to the (now short) page TTL
 * would make getRecommendationSessionPage reject cursors mid-scroll with
 * "Invalid or expired recommendation cursor".
 */
const HOME_FEED_RECOMMENDATION_SESSION_TTL_MS = 48 * 60 * 60 * 1000;

export const HOME_FEED_CACHE_VERSION = 'v3';

export const HOME_FEED_CACHE_GLOBAL_TAG = 'feed:global';

export const HOME_FEED_DEFAULT_LIMIT = 40;

export const HOME_FEED_MAX_LIMIT = 50;

export const HOME_FEED_RECOMMENDATION_CONTEXT_CACHE_TTL_SECONDS = 24 * 60 * 60;

export const MAX_FEED_CONTEXT_CONNECTIONS = 500;

export const MAX_FEED_CONTEXT_FOLLOWS = 500;

export const MAX_FEED_CONTEXT_EXPERIENCES = 12;

export const MAX_FEED_CONTEXT_PROJECTS = 12;

export const MAX_FEED_CONTEXT_EDUCATION = 12;

export async function selectHomeFeedAdPlacements(
  currentUserId: string,
  itemCount: number,
  itemOffset: number,
  sessionId?: string | null
) {
  try {
    return await selectManagedAdPlacements({
      userId: currentUserId,
      placement: 'feed',
      itemCount,
      itemOffset,
      sessionId,
    });
  } catch (error) {
    console.error('Failed to select home feed ads:', error);
    return [];
  }
}

export const feedSnapshotCacheTags = (...tags: Array<string | null | undefined>): string[] =>
  Array.from(new Set([HOME_FEED_CACHE_GLOBAL_TAG, ...feedCacheTags(...tags)]));

export async function enqueuePostCreatedFollowerFeedInvalidation(postId: string, authorId: string): Promise<void> {
  try {
    await getQueue(queueNames.cacheInvalidation).add(
      'post_created',
      {
        type: 'post_created',
        postId,
        authorId,
      },
      {
        jobId: `post_created:${postId}:follower_feed_cache_invalidation`,
      }
    );
  } catch (error) {
    logger.error({
      event: 'post.created.follower_feed_cache_invalidation.enqueue_failed',
      postId,
      authorId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildHomeFeedCacheKey(params: {
  userId: string;
  cursor: string;
  limit: number;
  mode: 'latest' | 'recommended';
  experimentVariant: string;
  snapshotWindow: number;
}): string {
  return [
    'posts:feed',
    HOME_FEED_CACHE_VERSION,
    `user:${params.userId}`,
    `mode:${params.mode}`,
    `variant:${params.experimentVariant}`,
    `window:${params.snapshotWindow}`,
    `limit:${params.limit}`,
    `cursor:${params.cursor || 'first'}`,
  ].join(':');
}

export function homeFeedSnapshotWindow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / HOME_FEED_SNAPSHOT_WINDOW_MS);
}

export function buildFeedRecommendationContextCacheKey(userId: string): string {
  return `posts:feed:recommendation-context:${HOME_FEED_CACHE_VERSION}:${userId}`;
}

export function shouldBypassHomeFeedCache(req: Request): boolean {
  return (
    Boolean(ensureString(req.query.cacheBust)) ||
    Boolean(ensureString(req.query._t)) ||
    String(req.headers['x-vormex-feed-refresh'] || '').toLowerCase() === 'true'
  );
}

export const MAX_FEED_IMPRESSION_BATCH = 100;

/**
 * Ingests viewport impressions reported by a client.
 *
 * Impressions are reported by the client rather than recorded when a row is
 * served, because a served row is only a candidate: the viewer may never scroll
 * to it. Counting served rows would demote posts nobody actually saw.
 *
 * Accepts two payload shapes, so no shipped client breaks:
 *   - `{ postIds: string[] }`                       (legacy, still supported)
 *   - `{ feedSessionId, rankingVersion, impressions: [{ postId, creatorId,
 *        position, candidateSource, rankingScore, visibleMs, dwellMs }] }`
 *
 * The rich shape is what lets the ranker learn — per-creator skip rates, dwell,
 * and which candidate source actually earns attention. Entries that report a
 * visible time below the qualifying threshold are dropped server-side, so a card
 * that merely flickered past does not count.
 *
 * Ranking itself stays entirely server-side. Clients only report what entered
 * the viewport; they never influence ordering directly.
 */
export const recordFeedImpressions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const impressions = normalizeImpressionPayload(req.body).slice(0, MAX_FEED_IMPRESSION_BATCH);
    if (impressions.length === 0) {
      res.json({ ok: true, recorded: 0 });
      return;
    }

    // Fire-and-forget inside; the client does not wait on the write.
    writeFeedImpressions(String(req.user.userId), impressions);
    res.json({ ok: true, recorded: impressions.length });
  } catch (error) {
    console.error('recordFeedImpressions error:', error);
    res.status(500).json({ error: 'Failed to record feed impressions' });
  }
};

export async function buildFeedRecommendationContextForUser(currentUserId: string) {
  const cacheKey = buildFeedRecommendationContextCacheKey(currentUserId);
  const cachedContextInput = await cacheService.get<FeedRecommendationProfileInput>(cacheKey);
  if (cachedContextInput) {
    return buildFeedRecommendationProfile(cachedContextInput);
  }

  const profileViewsModel = (prismaRead as any).profile_views;
  const followsModel = (prismaRead as any).follows;

  const [user, acceptedConnections, following, recentViews] = await Promise.all([
    prismaRead.user.findUnique({
      where: { id: currentUserId },
      select: {
        id: true,
        college: true,
        branch: true,
        degree: true,
        interests: true,
        skills: {
          select: {
            skill: {
              select: { name: true },
            },
          },
        },
        experiences: {
          select: { skills: true },
          orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
          take: MAX_FEED_CONTEXT_EXPERIENCES,
        },
        projects: {
          select: { techStack: true },
          orderBy: [{ featured: 'desc' }, { startDate: 'desc' }],
          take: MAX_FEED_CONTEXT_PROJECTS,
        },
        educationHistory: {
          select: {
            school: true,
            degree: true,
            fieldOfStudy: true,
          },
          orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
          take: MAX_FEED_CONTEXT_EDUCATION,
        },
      },
    }),
    prismaRead.connections.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: currentUserId }, { addresseeId: currentUserId }],
      },
      select: { requesterId: true, addresseeId: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_FEED_CONTEXT_CONNECTIONS,
    }),
    followsModel?.findMany
      ? followsModel.findMany({
          where: { followerId: currentUserId },
          select: { followingId: true },
          orderBy: { createdAt: 'desc' },
          take: MAX_FEED_CONTEXT_FOLLOWS,
        })
      : Promise.resolve([]),
    profileViewsModel?.findMany
      ? profileViewsModel.findMany({
          where: {
            viewerId: currentUserId,
            viewedId: { not: currentUserId },
            viewedAt: { gte: new Date(Date.now() - RECENT_PROFILE_LOOKBACK_MS) },
          },
          select: { viewedId: true, viewedAt: true },
          orderBy: { viewedAt: 'desc' },
          take: MAX_RECENT_PROFILE_SIGNALS * 3,
        })
      : Promise.resolve([]),
  ]);

  const skillHints = compactStringList([
    ...(user?.skills || []).map((item: any) => item?.skill?.name),
    ...(user?.experiences || []).flatMap((experience: any) => experience?.skills || []),
    ...(user?.projects || []).flatMap((project: any) => project?.techStack || []),
  ]);

  const educationHints = compactStringList([
    user?.college,
    user?.branch,
    user?.degree,
    ...(user?.educationHistory || []).flatMap((education: any) => [
      education?.school,
      education?.degree,
      education?.fieldOfStudy,
    ]),
  ]);

  const contextInput: FeedRecommendationProfileInput = {
    currentUserId,
    skills: skillHints,
    interests: compactStringList(user?.interests || []),
    educationHints,
    connectionAuthorIds: connectionPeerIds(acceptedConnections || [], currentUserId),
    followingAuthorIds: (following || []).map((item: any) => item.followingId),
    recentProfileWeights: recentProfileWeights(recentViews || [], currentUserId),
  };

  void cacheService
    .set(
      cacheKey,
      contextInput,
      HOME_FEED_RECOMMENDATION_CONTEXT_CACHE_TTL_SECONDS,
      [`feed:${currentUserId}`, `user:${currentUserId}`]
    )
    .catch((cacheError: unknown) => {
      console.error('Failed to cache feed recommendation context:', cacheError);
    });

  return buildFeedRecommendationProfile(contextInput);
}

export /**
 * A signed recommendation-session cursor is `<base64url>.<base64url>`. Legacy
 * recommended cursors are `rec:<...>`. Telling them apart lets a cursor minted
 * before the rollout keep resolving against the old ranker.
 */
function isRecommendationSessionCursor(cursor: string): boolean {
  return cursor.includes('.') && !cursor.startsWith('rec:');
}

export /**
 * Developer-only explain payload for one ranking run.
 *
 * Exposes another user's relationship and affinity values, so every caller must
 * pass `feedDebugRequested` first.
 */
function buildFeedDebugPayload(ranked: BuildFeedOutput, limit: number) {
  return {
    rankingVersion: ranked.rankingVersion,
    candidateCount: ranked.candidateCount,
    eligibleCount: ranked.eligibleCount,
    sourceCounts: ranked.sourceCounts,
    removedCounts: ranked.removedCounts,
    failedSources: ranked.failedSources,
    explorationShare: ranked.explorationShare,
    coldStart: ranked.coldStart,
    degraded: ranked.degraded,
    timings: ranked.timings,
    items: buildFeedDebugEntries(ranked, limit),
  };
}

export /**
 * Hydrates an ordered list of post ids into full API responses.
 *
 * Re-applies `buildPostVisibilityWhere` and the block list: ranking decided the
 * order, but authorisation is decided here, every time, server-side. A post the
 * viewer cannot access is dropped even if a candidate generator produced it.
 */
async function hydrateFeedV2Page(
  currentUserId: string,
  items: RecommendationSnapshotItem[],
  blockedUserIds: string[]
): Promise<any[]> {
  const ids = items.map((item) => item.entityId).filter(Boolean);
  if (ids.length === 0) return [];

  const posts = await prismaRead.post.findMany({
    where: {
      id: { in: ids },
      isActive: true,
      ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
      ...(await buildPostVisibilityWhere(currentUserId)),
    },
    include: postResponseInclude(currentUserId, { authorProfileSignals: true }),
    relationLoadStrategy: JOIN_RELATIONS,
  });

  const postById = new Map(posts.map((post) => [post.id, post]));
  const ordered = items.map((item) => postById.get(item.entityId)).filter((post): post is NonNullable<typeof post> => Boolean(post));

  await attachReactionSummaries(prismaRead as any, ordered);
  const authorVisibilityByUser = await getPremiumVisibilityByUserIds(
    ordered.map((post: any) => post.authorId)
  );

  return items.flatMap((item) => {
    const post: any = postById.get(item.entityId);
    if (!post) return [];
    const withPremium = {
      ...post,
      author: post.author ? applyPremiumVisibilityToUser(post.author, authorVisibilityByUser) : post.author,
    };
    return [{
      ...mapPostResponse(withPremium, currentUserId),
      reasonCode: item.reasonCode,
      reasonText: item.reasonText,
      source: item.source,
      position: item.position,
      isBoosted: Boolean(item.isBoosted),
      socialActors: item.socialActors || [],
    }];
  });
}

export interface FeedV2RequestContext {
  req: AuthRequest;
  res: Response;
  currentUserId: string;
  cursor: string;
  limit: number;
  adSessionId: string;
  adItemOffset: number;
  blockedUserIds: string[];
  requestStartedAtMs: number;
  experimentVariant: string;
}
