import { normalizeToken } from "./feed-normalization.util";
/**
 * Loads everything about the viewer that ranking depends on, in one batched
 * pass, and caches it.
 *
 * This is the only place the pipeline touches the viewer's social graph. Doing
 * it once per request (and reusing it for 10 minutes) is what keeps feed-v2 to a
 * bounded query count instead of asking "is this author a connection?" per
 * candidate.
 */

import { Prisma } from '@prisma/client';
import { prismaRead } from '../../../../config/prisma';
import { cacheService } from '../../../../infrastructure/cache/cache.service';
import { getFeedConfig } from './feed-config';
import type { FeedViewerContext } from './feed-types';

const CONTEXT_CACHE_VERSION = 'v1';

const MAX_FOLLOWING = 1_000;
const MAX_CONNECTIONS = 1_000;
const MAX_SECOND_DEGREE = 500;
/** Bounds the fan-out of the friends-of-friends query. */
const SECOND_DEGREE_SEED_LIMIT = 150;
const MAX_INTERACTED_CREATORS = 200;
const MAX_PROFILE_VISITS = 60;
const MAX_MESSAGE_PEERS = 200;

/** Serialisable form of the context, so it survives a Redis round trip. */
interface CachedViewerContext extends Omit<FeedViewerContext, 'isColdStart'> {
  cachedAtMs: number;
}

function cacheKey(userId: string): string {
  return `feed:v2:viewer-context:${CONTEXT_CACHE_VERSION}:${userId}`;
}



function tokenList(values: Array<unknown>, limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const value of values.flat()) {
    const token = normalizeToken(value);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    output.push(token);
    if (output.length >= limit) break;
  }

  return output;
}

/**
 * Turns "how many interactions, how recently" into a 0..1 affinity per creator.
 *
 * Rank-based rather than count-based on purpose: a viewer who likes hundreds of
 * posts should still produce a spread of affinities rather than saturating every
 * creator at 1.
 */
function affinityFromRankedIds(ids: string[], limit: number): Record<string, number> {
  const output: Record<string, number> = {};
  const bounded = ids.slice(0, limit);

  bounded.forEach((id, index) => {
    if (!id) return;
    const rankScore = 1 - index / Math.max(1, bounded.length);
    output[id] = Math.max(output[id] || 0, Math.min(1, 0.25 + 0.75 * rankScore));
  });

  return output;
}

async function loadFromDatabase(userId: string, nowMs: number): Promise<CachedViewerContext> {
  const config = getFeedConfig();
  const interactionSince = new Date(nowMs - config.relationship.interactionLookbackDays * 86_400_000);
  const recentConnectionSince = new Date(nowMs - config.relationship.recentConnectionDays * 86_400_000);

  const [
    user,
    connections,
    following,
    followers,
    likedCreators,
    commentedCreators,
    savedCreators,
    profileVisits,
    messagePeers,
  ] = await Promise.all([
    prismaRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        college: true,
        branch: true,
        degree: true,
        graduationYear: true,
        currentYear: true,
        interests: true,
        skills: { select: { skill: { select: { name: true } } }, take: 40 },
        experiences: { select: { skills: true }, orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }], take: 12 },
        projects: { select: { techStack: true }, orderBy: [{ featured: 'desc' }, { startDate: 'desc' }], take: 12 },
        educationHistory: {
          select: { school: true, degree: true, fieldOfStudy: true },
          orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
          take: 8,
        },
        user_onboarding: { select: { wantToLearn: true, canTeach: true, lookingFor: true } },
        onboarding_profiles: { select: { skillsToLearn: true, skillsToTeach: true, campus: true, branch: true } },
      },
    }),

    prismaRead.connections.findMany({
      where: { status: 'accepted', OR: [{ requesterId: userId }, { addresseeId: userId }] },
      select: { requesterId: true, addresseeId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_CONNECTIONS,
    }),

    prismaRead.follows.findMany({
      where: { followerId: userId },
      select: { followingId: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_FOLLOWING,
    }),

    prismaRead.follows.findMany({
      where: { followingId: userId },
      select: { followerId: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_FOLLOWING,
    }),

    // Creators whose posts the viewer liked, most recent first.
    prismaRead.$queryRaw<Array<{ authorId: string }>>(Prisma.sql`
      SELECT p."authorId", MAX(l."createdAt") AS "lastAt"
      FROM "post_likes" l
      JOIN "posts" p ON p."id" = l."postId"
      WHERE l."userId" = ${userId} AND l."createdAt" >= ${interactionSince} AND p."authorId" <> ${userId}
      GROUP BY p."authorId"
      ORDER BY "lastAt" DESC
      LIMIT ${MAX_INTERACTED_CREATORS}
    `),

    prismaRead.$queryRaw<Array<{ authorId: string }>>(Prisma.sql`
      SELECT p."authorId", MAX(c."createdAt") AS "lastAt"
      FROM "post_comments" c
      JOIN "posts" p ON p."id" = c."postId"
      WHERE c."authorId" = ${userId} AND c."createdAt" >= ${interactionSince} AND p."authorId" <> ${userId}
      GROUP BY p."authorId"
      ORDER BY "lastAt" DESC
      LIMIT ${MAX_INTERACTED_CREATORS}
    `),

    prismaRead.$queryRaw<Array<{ authorId: string }>>(Prisma.sql`
      SELECT p."authorId", MAX(s."createdAt") AS "lastAt"
      FROM "saved_posts" s
      JOIN "posts" p ON p."id" = s."postId"
      WHERE s."userId" = ${userId} AND s."createdAt" >= ${interactionSince} AND p."authorId" <> ${userId}
      GROUP BY p."authorId"
      ORDER BY "lastAt" DESC
      LIMIT ${MAX_INTERACTED_CREATORS}
    `),

    prismaRead.profile_views.findMany({
      where: { viewerId: userId, viewedId: { not: userId }, viewedAt: { gte: interactionSince } },
      select: { viewedId: true },
      orderBy: { viewedAt: 'desc' },
      take: MAX_PROFILE_VISITS * 3,
    }),

    prismaRead.messages.groupBy({
      by: ['receiverId'],
      where: { senderId: userId, createdAt: { gte: interactionSince } },
      _count: { _all: true },
      orderBy: { _count: { receiverId: 'desc' } },
      take: MAX_MESSAGE_PEERS,
    }),
  ]);

  const connectionIds: string[] = [];
  const recentConnectionIds: string[] = [];
  for (const row of connections) {
    const peerId = row.requesterId === userId ? row.addresseeId : row.requesterId;
    if (!peerId || peerId === userId) continue;
    connectionIds.push(peerId);
    if (row.updatedAt && row.updatedAt >= recentConnectionSince) recentConnectionIds.push(peerId);
  }

  const followingIds = following.map((row) => row.followingId).filter(Boolean);
  const followerIdSet = new Set(followers.map((row) => row.followerId).filter(Boolean));
  const mutualFollowIds = followingIds.filter((id) => followerIdSet.has(id));

  const networkIds = new Set<string>([userId, ...connectionIds, ...followingIds]);

  // Second degree: peers of the viewer's connections that the viewer does not
  // already know. Seeded from a bounded slice so the fan-out stays predictable.
  const seedIds = connectionIds.slice(0, SECOND_DEGREE_SEED_LIMIT);
  const secondDegreeRows = seedIds.length
    ? await prismaRead.connections.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: { in: seedIds } }, { addresseeId: { in: seedIds } }],
        },
        select: { requesterId: true, addresseeId: true },
        take: 4_000,
      })
    : [];

  const secondDegreeCounts = new Map<string, number>();
  for (const row of secondDegreeRows) {
    for (const peerId of [row.requesterId, row.addresseeId]) {
      if (!peerId || networkIds.has(peerId)) continue;
      secondDegreeCounts.set(peerId, (secondDegreeCounts.get(peerId) || 0) + 1);
    }
  }
  const secondDegreeIds = Array.from(secondDegreeCounts.entries())
    // More mutual connections first: those are the strongest weak ties.
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_SECOND_DEGREE)
    .map(([id]) => id);

  // Saves and comments express more intent than likes, so they lead the ranking
  // that becomes creator affinity.
  const interactedCreatorIds = [
    ...savedCreators.map((row) => row.authorId),
    ...commentedCreators.map((row) => row.authorId),
    ...likedCreators.map((row) => row.authorId),
  ].filter(Boolean);

  const dedupedInteractedIds = Array.from(new Set(interactedCreatorIds));
  const creatorAffinity = affinityFromRankedIds(dedupedInteractedIds, MAX_INTERACTED_CREATORS);

  const visitedIds = Array.from(
    new Set(profileVisits.map((row) => row.viewedId).filter((id): id is string => Boolean(id)))
  );
  const profileVisitAffinity = affinityFromRankedIds(visitedIds, MAX_PROFILE_VISITS);

  const messageCounts: Record<string, number> = {};
  for (const row of messagePeers) {
    if (row.receiverId) messageCounts[row.receiverId] = Number(row._count?._all || 0);
  }

  const onboarding = user?.user_onboarding;
  const onboardingProfile = user?.onboarding_profiles;

  const skillTokens = tokenList(
    [
      (user?.skills || []).map((item) => item?.skill?.name),
      (user?.experiences || []).map((item) => item?.skills || []),
      (user?.projects || []).map((item) => item?.techStack || []),
      onboarding?.canTeach || [],
      onboarding?.wantToLearn || [],
      onboardingProfile?.skillsToTeach || [],
      onboardingProfile?.skillsToLearn || [],
    ],
    50
  );

  const interestTokens = tokenList([user?.interests || [], onboarding?.lookingFor || []], 40);

  const educationTokens = tokenList(
    [
      user?.college,
      user?.branch,
      user?.degree,
      onboardingProfile?.campus,
      onboardingProfile?.branch,
      (user?.educationHistory || []).map((item) => [item?.school, item?.degree, item?.fieldOfStudy]),
    ],
    30
  );

  const interactionCount =
    dedupedInteractedIds.length + visitedIds.length + Object.keys(messageCounts).length;

  return {
    userId,
    college: user?.college ?? null,
    branch: user?.branch ?? null,
    degree: user?.degree ?? null,
    graduationYear: user?.graduationYear ?? null,
    interestTokens,
    skillTokens,
    educationTokens,
    followingIds,
    connectionIds,
    recentConnectionIds,
    mutualFollowIds,
    secondDegreeIds,
    creatorAffinity,
    profileVisitAffinity,
    messageCounts,
    interactionCount,
    cachedAtMs: nowMs,
  };
}

/** Empty context, used when the viewer row is unreadable. Never throws. */
export function emptyViewerContext(userId: string): FeedViewerContext {
  return {
    userId,
    college: null,
    branch: null,
    degree: null,
    graduationYear: null,
    interestTokens: [],
    skillTokens: [],
    educationTokens: [],
    followingIds: [],
    connectionIds: [],
    recentConnectionIds: [],
    mutualFollowIds: [],
    secondDegreeIds: [],
    creatorAffinity: {},
    profileVisitAffinity: {},
    messageCounts: {},
    interactionCount: 0,
    isColdStart: true,
  };
}

export async function loadFeedViewerContext(
  userId: string,
  nowMs: number = Date.now()
): Promise<FeedViewerContext> {
  const config = getFeedConfig();

  const cached = await cacheService
    .getOrSet<CachedViewerContext>(cacheKey(userId), () => loadFromDatabase(userId, nowMs), {
      /*
       * Stale-while-revalidate rather than a plain TTL. Rebuilding this costs
       * ten social-graph queries, and with a plain TTL every expiry handed that
       * bill to whichever user happened to open the feed next. Now the stale
       * context is served immediately and the rebuild happens behind the
       * response, so the queries stay off the request path after the viewer's
       * very first feed load.
       *
       * Serving a context up to a few hours old is safe: it only shapes ranking,
       * and the entries a stale context would miss — a brand-new follow or
       * connection — already drop this key through the tags below.
       */
      swr: {
        softTtlSeconds: config.pagination.viewerContextTtlSeconds,
        hardTtlSeconds: Math.max(
          config.pagination.viewerContextHardTtlSeconds,
          config.pagination.viewerContextTtlSeconds
        ),
      },
      // Reuses the tags the rest of the feed already invalidates on, so a new
      // follow or connection drops this context too.
      tags: [`feed:${userId}`, `user:${userId}`],
      lockTtlMs: 20_000,
    })
    .catch((error: unknown) => {
      console.error('[feed-v2] viewer context load failed:', error);
      return null;
    });

  if (!cached) return emptyViewerContext(userId);

  return {
    ...cached,
    isColdStart: cached.interactionCount < config.exploration.coldStartInteractionThreshold,
  };
}

/** Drops a viewer's cached context. Used when their graph or profile changes. */
export async function invalidateFeedViewerContext(userId: string): Promise<void> {
  await cacheService.del(cacheKey(userId)).catch(() => undefined);
}
