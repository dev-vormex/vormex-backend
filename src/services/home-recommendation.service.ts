import { Prisma } from '@prisma/client';
import { prismaRead } from '../config/prisma';
import { growthJobs } from '../data/growth-hub.catalog';
import {
  applyConstrainedPositionExploration,
  freshnessScore,
  rankRecommendationCandidates,
  stableUnitInterval,
  type RankedRecommendation,
  type RecommendationCandidate,
  type RecommendationFeaturePriors,
  type RecommendationSource,
} from './recommendation-engine.service';
import { selectPostBoostPlacements } from './premium-post-boost.service';
import { loadRecommendationModelBundle } from './recommendation-model-serving.service';
import { loadCachedSemanticScores } from './recommendation-embedding.service';

function toSet(value: unknown): Set<string> {
  if (value instanceof Set) return new Set(Array.from(value).map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set();
}

function tokensFromWeights(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>).map((item) => item.toLowerCase()).filter(Boolean);
}

function searchablePostText(post: any): string {
  const metadata = post?.metadata && typeof post.metadata === 'object' ? post.metadata : {};
  return [
    post?.content,
    post?.type,
    post?.author?.name,
    post?.author?.headline,
    post?.author?.college,
    post?.author?.branch,
    metadata.articleTitle,
    ...(Array.isArray(metadata.articleTags) ? metadata.articleTags : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function lexicalAffinity(text: string, tokens: string[]): number | undefined {
  if (tokens.length === 0) return undefined;
  const unique = new Set(tokens);
  let matches = 0;
  for (const token of unique) if (text.includes(token)) matches += 1;
  return Math.min(1, matches / Math.min(5, unique.size));
}

function logNormalize(value: number, scale: number): number {
  return Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(scale));
}

export async function rankHomePostCandidates(input: {
  userId: string;
  posts: any[];
  recommendationContext: any;
  seenAtByPostId?: Record<string, Date | string>;
  nowMs: number;
  experimentVariant: string;
  priors?: RecommendationFeaturePriors;
}): Promise<RankedRecommendation<any>[]> {
  const context = input.recommendationContext || {};
  const connectionIds = toSet(context.connectionAuthorIds);
  const followingIds = toSet(context.followingAuthorIds);
  const networkIds = Array.from(new Set([...connectionIds, ...followingIds]));
  const postIds = input.posts.map((post) => String(post.id));
  const [networkEngagement, stats, feedback, modelBundle, semanticScores, cascadeDeliveries] = await Promise.all([
    networkIds.length && postIds.length
      ? prismaRead.postLike.findMany({
          where: { userId: { in: networkIds.slice(0, 500) }, postId: { in: postIds } },
          select: { postId: true, userId: true },
          take: 10_000,
        })
      : Promise.resolve([]),
    postIds.length
      ? prismaRead.$queryRaw<any[]>(Prisma.sql`
          SELECT "entityId", SUM("organicImpressions")::int AS impressions,
                 SUM("organicQualifiedPositives")::int AS positives,
                 SUM("organicNegativeFeedback")::int AS negatives
          FROM "recommendation_item_daily_stats"
          WHERE "entityType" = 'POST' AND "entityId" IN (${Prisma.join(postIds)})
            AND "day" >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY "entityId"
        `).catch(() => [])
      : Promise.resolve([]),
    prismaRead.$queryRaw<any[]>(Prisma.sql`
      SELECT "entityId", "authorId", "feedbackType" FROM "recommendation_feedback"
      WHERE "userId" = ${input.userId} AND "isActive" = true
    `).catch(() => []),
    loadRecommendationModelBundle('HOME'),
    loadCachedSemanticScores(input.userId, 'post', postIds),
    postIds.length ? prismaRead.$queryRaw<any[]>(Prisma.sql`
      SELECT "entityId", "wave" FROM "recommendation_cascade_deliveries"
      WHERE "viewerId" = ${input.userId} AND "surface" = 'HOME' AND "entityType" = 'POST'
        AND "entityId" IN (${Prisma.join(postIds)})
    `).catch(() => []) : Promise.resolve([]),
  ]);

  const engagedPostIds = new Set(networkEngagement.map((row: any) => String(row.postId)));
  const cascadeWaveByPost = new Map(cascadeDeliveries.map((row: any) => [String(row.entityId), Number(row.wave || 0)]));
  const statsById = new Map(stats.map((row: any) => [String(row.entityId), row]));
  const excludedEntityIds = new Set(feedback.filter((row: any) => row.feedbackType === 'NOT_INTERESTED').map((row: any) => String(row.entityId)));
  const hiddenAuthorIds = new Set(feedback.filter((row: any) => row.feedbackType === 'HIDE_AUTHOR').map((row: any) => String(row.authorId || '')));
  const semanticTokens = [
    ...tokensFromWeights(context.skillWeights),
    ...tokensFromWeights(context.interestWeights),
  ];
  const cohortTokens = tokensFromWeights(context.educationWeights);

  const candidates: RecommendationCandidate<any>[] = input.posts
    .filter((post) => !excludedEntityIds.has(String(post.id)) && !hiddenAuthorIds.has(String(post.authorId)))
    .map((post) => {
      const authorId = String(post.authorId || post.author?.id || '');
      const text = searchablePostText(post);
      const semantic = semanticScores.get(String(post.id)) ?? lexicalAffinity(text, semanticTokens);
      const cohortFit = lexicalAffinity(text, cohortTokens);
      const network = followingIds.has(authorId) || connectionIds.has(authorId) || authorId === input.userId;
      const cascadeWave = cascadeWaveByPost.get(String(post.id)) || 0;
      const networkEngaged = engagedPostIds.has(String(post.id)) || (cascadeWave > 0 && cascadeWave <= 2);
      const sources: RecommendationSource[] = [];
      if (network) sources.push('NETWORK');
      if (networkEngaged) sources.push('NETWORK_ENGAGED');
      if (semantic !== undefined && semantic > 0) sources.push('SEMANTIC');
      if ((cohortFit !== undefined && cohortFit > 0) || Number(post.likesCount || 0) + Number(post.commentsCount || 0) >= 3) {
        sources.push('COHORT_TRENDING');
      }
      if (cascadeWave >= 3 && !sources.includes('COHORT_TRENDING')) sources.push('COHORT_TRENDING');
      if (stableUnitInterval(`explore:${input.userId}:${post.id}`) < 0.25 || sources.length === 0) sources.push('EXPLORATION');

      const itemStats = statsById.get(String(post.id));
      const impressions = Number(itemStats?.impressions || 0);
      const positives = Number(itemStats?.positives || 0);
      const negatives = Number(itemStats?.negatives || 0);
      const quality = impressions > 0 ? (positives + 10 * 0.5) / (impressions + 10) : undefined;
      const engagement = Number(post.likesCount || 0) + 3 * Number(post.commentsCount || 0) + 5 * Number(post.sharesCount || 0);
      const author = post.author || {};
      const premiumTieBreak = Math.min(0.02,
        (author.profileBoostActive ? 0.012 : 0) + (author.isPremium ? 0.008 : 0));

      const features = {
        semantic,
        relationship: network ? (followingIds.has(authorId) ? 1 : 0.85) : networkEngaged ? 0.45 : undefined,
        socialProof: logNormalize(engagement, 250),
        quality,
        freshness: freshnessScore(post.createdAt, 24, input.nowMs),
        exploration: 1 - logNormalize(impressions, 1_000),
        cohortFit,
      };
      return {
        id: String(post.id),
        entityType: 'POST',
        authorId,
        value: post,
        sources,
        features,
        learnedUtility: modelBundle.learnedUtilityFor(features),
        organicImpressions: impressions,
        negativeFeedbackRate: impressions > 0 ? negatives / impressions : 0,
        seenAt: input.seenAtByPostId?.[String(post.id)] || null,
        meaningfulActivityAt: post.updatedAt,
        premiumTieBreak,
      } satisfies RecommendationCandidate<any>;
    });

  let ranked = rankRecommendationCandidates(candidates, {
    limit: 500,
    priors: input.priors || modelBundle.featurePriors,
    nowMs: input.nowMs,
  });
  if (process.env.NAMED_ACTIVITY_RECOMMENDATIONS_LEGAL_BASIS_APPROVED === 'true' && networkIds.length > 0) {
    const publicPostIds = ranked.filter((item) => String(item.value?.visibility || '').toLowerCase() === 'public').map((item) => item.id);
    if (publicPostIds.length > 0) {
      const actors = await prismaRead.$queryRaw<any[]>(Prisma.sql`
        SELECT l."postId", u."id", u."name", u."profileImage", l."createdAt"
        FROM "post_likes" l
        JOIN "users" u ON u."id" = l."userId"
        LEFT JOIN "recommendation_user_profiles" p ON p."userId" = u."id"
        WHERE l."postId" IN (${Prisma.join(publicPostIds)})
          AND l."userId" IN (${Prisma.join(networkIds)})
          AND u."isBanned" = false
          AND COALESCE(p."activityRecommendationsEnabled", true) = true
        ORDER BY l."createdAt" DESC
      `).catch(() => []);
      const byPost = new Map<string, any[]>();
      for (const actor of actors) {
        const list = byPost.get(String(actor.postId)) || [];
        if (list.length < 2 && !list.some((item) => item.id === actor.id)) {
          list.push({ id: actor.id, name: actor.name, profileImage: actor.profileImage });
          byPost.set(String(actor.postId), list);
        }
      }
      ranked = ranked.map((item) => {
        const socialActors = byPost.get(item.id) || [];
        return socialActors.length ? {
          ...item,
          socialActors,
          reasonCode: 'NETWORK_FOUND_USEFUL',
          reasonText: `${socialActors[0].name}${socialActors.length > 1 ? ` and ${socialActors.length - 1} other` : ''} reacted to this`,
        } : item;
      });
    }
  }
  return input.experimentVariant === 'training_exploration'
    ? applyConstrainedPositionExploration(ranked, `${input.userId}:${input.nowMs}`)
    : ranked;
}

function textMatchesTokens(text: string, tokens: string[]): number {
  const normalized = text.toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

export async function selectHomeRecommendationModules(input: {
  userId: string;
  organicItemCount: number;
  blockedAuthorIds: string[];
  recommendationContext: any;
}): Promise<any[]> {
  if (input.organicItemCount < 8) return [];
  const boostPlacements = await selectPostBoostPlacements({
    viewerId: input.userId,
    organicItemCount: input.organicItemCount,
    blockedAuthorIds: input.blockedAuthorIds,
  }).catch(() => []);
  const boostedPosts = boostPlacements.length > 0
    ? await prismaRead.post.findMany({
        where: { id: { in: boostPlacements.map((placement) => placement.postId) }, isActive: true, visibility: 'public' },
        select: {
          id: true, authorId: true, content: true, type: true, mediaUrls: true, visibility: true,
          likesCount: true, commentsCount: true, sharesCount: true, createdAt: true, updatedAt: true,
          author: { select: { id: true, name: true, username: true, profileImage: true, headline: true } },
        },
      })
    : [];
  const boostedPostById = new Map(boostedPosts.map((post) => [post.id, post]));
  const hydratedBoostPlacements = boostPlacements.map((placement) => ({
    ...placement,
    reasonCode: 'BOOSTED_POST',
    reasonText: 'Sponsored by this Premium creator',
    items: boostedPostById.has(placement.postId) ? [{
      ...boostedPostById.get(placement.postId),
      isBoosted: true,
      position: placement.position,
      reasonCode: 'BOOSTED_POST',
      reasonText: 'Sponsored by this Premium creator',
      source: 'PREMIUM_BOOST',
    }] : [],
  }));
  const remainingBudget = Math.max(0, 3 - boostPlacements.length);
  if (remainingBudget === 0) return hydratedBoostPlacements;
  const network = Array.from(new Set([
    ...toSet(input.recommendationContext?.connectionAuthorIds),
    ...toSet(input.recommendationContext?.followingAuthorIds),
    input.userId,
    ...input.blockedAuthorIds,
  ]));
  const tokens = [
    ...tokensFromWeights(input.recommendationContext?.skillWeights),
    ...tokensFromWeights(input.recommendationContext?.interestWeights),
  ];
  const [people, reels, events] = await Promise.all([
    prismaRead.user.findMany({
      where: { id: { notIn: network.slice(0, 1_000) }, isBanned: false, onboardingCompleted: true },
      select: { id: true, username: true, name: true, headline: true, profileImage: true, interests: true },
      orderBy: { lastActiveAt: 'desc' },
      take: 20,
    }),
    prismaRead.reels.findMany({
      where: { status: 'ready', visibility: 'public', authorId: { notIn: input.blockedAuthorIds } },
      select: { id: true, title: true, caption: true, thumbnailUrl: true, authorId: true, viewsCount: true },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: 10,
    }),
    prismaRead.campus_events.findMany({
      where: { endsAt: { gte: new Date() } },
      select: { id: true, title: true, description: true, startsAt: true, campus: true, coverImageUrl: true },
      orderBy: { startsAt: 'asc' },
      take: 10,
    }),
  ]);
  const jobs = [...growthJobs]
    .sort((left, right) => textMatchesTokens(`${right.title} ${right.description} ${right.skills.join(' ')}`, tokens)
      - textMatchesTokens(`${left.title} ${left.description} ${left.skills.join(' ')}`, tokens))
    .slice(0, 5);
  const modules = [
    people.length ? { type: 'PEOPLE', reasonCode: 'PEOPLE_FOR_YOU', reasonText: 'People who match your goals', items: people.slice(0, 5) } : null,
    reels.length ? { type: 'REELS', reasonCode: 'REELS_FOR_YOU', reasonText: 'Reels for your interests', items: reels.slice(0, 5) } : null,
    jobs.length ? { type: 'JOBS', reasonCode: 'JOBS_FOR_YOU', reasonText: 'Opportunities matching your skills', items: jobs } : null,
    events.length ? { type: 'EVENTS', reasonCode: 'EVENTS_FOR_YOU', reasonText: 'Events you may find useful', items: events.slice(0, 5) } : null,
  ].filter(Boolean).slice(0, remainingBudget) as any[];
  const positions = [9, 16, 23];
  return [...hydratedBoostPlacements, ...modules]
    .slice(0, 3)
    .map((placement, index) => ({ ...placement, position: positions[index] }));
}
