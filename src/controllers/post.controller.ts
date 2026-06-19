// @ts-nocheck
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { prisma, prismaRead } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { notificationService } from '../services/notification.service';
import { recordActivity } from '../services/activity.service';
import { cacheService } from '../services/cache.service';
import { updateEngagementStreak } from './engagement.controller';
import { queueNames } from '../infrastructure/queue/queue-names';
import { getQueue } from '../infrastructure/queue/queues';
import { logger } from '../lib/logger';
import {
  buildFeedRecommendationProfile,
  decodeRecommendedFeedCursor,
  rankFeedPage,
  recommendedFeedCandidateLimit,
  type FeedRecommendationProfileInput,
} from '../services/feed-algorithm.service';
import {
  enqueueCacheInvalidation,
  enqueueNotificationDelivery,
  enqueueRealtimeFanout,
} from '../outbox/helpers';
import {
  applyPremiumVisibilityToUser,
  getPremiumVisibilityByUserIds,
} from '../services/premium-visibility.service';
import {
  extractDomain,
  mapPollOptionsForResponse,
  mapPostResponse,
  parseBooleanField,
  parseNumberField,
  parseStringArrayField,
  parseVisibility,
  normalizeUrl,
  enrichLinkMetadataFromUrl,
  type StoredPostMetadata,
} from '../utils/post.util';
import { parseStoredMusicAttachment } from '../utils/music.util';
import { buildPostVisibilityWhere, canViewPost } from '../utils/access-control.util';
import { enforceTrustTierLimit, getBlockedUserIds, safetyErrorResponse } from '../services/trust-safety.service';
import { selectManagedAdPlacements } from '../services/managed-ad.service';
import {
  createStorageUploadIntent,
  validateFinalizedStorageMedia,
  type FinalizedDirectMedia,
} from '../utils/direct-media-upload.util';
import {
  createdAtDescKeysetWhere,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from '../utils/keyset-pagination.util';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const FEED_REALTIME_ROOM = 'feed:global';
const FEED_IMPRESSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_IMPRESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const HOME_FEED_CACHE_TTL_SECONDS = 60;
const HOME_FEED_CACHE_VERSION = 'v2';
const HOME_FEED_CACHE_GLOBAL_TAG = 'feed:global';
const HOME_FEED_DEFAULT_LIMIT = 40;
const HOME_FEED_MAX_LIMIT = 50;
const HOME_FEED_RECOMMENDATION_CONTEXT_CACHE_TTL_SECONDS = 2 * 60;
const RECENT_PROFILE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECENT_PROFILE_SIGNALS = 24;
const MAX_FEED_CONTEXT_CONNECTIONS = 500;
const MAX_FEED_CONTEXT_FOLLOWS = 500;
const MAX_FEED_CONTEXT_EXPERIENCES = 12;
const MAX_FEED_CONTEXT_PROJECTS = 12;
const MAX_FEED_CONTEXT_EDUCATION = 12;
let lastFeedImpressionCleanupAt = 0;
const postAuthorSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
  identityTrustLevel: true,
};
const postAuthorWithProfileSignalsSelect = {
  ...postAuthorSelect,
  college: true,
  branch: true,
  degree: true,
};

const postResponseInclude = (
  currentUserId: string,
  options: { authorProfileSignals?: boolean } = {}
) => ({
  author: {
    select: options.authorProfileSignals
      ? postAuthorWithProfileSignalsSelect
      : postAuthorSelect,
  },
  collaborators: {
    include: {
      user: {
        select: postAuthorSelect,
      },
    },
  },
  likes: {
    where: { userId: currentUserId },
    select: { userId: true },
  },
  saved_posts: {
    where: { userId: currentUserId },
    select: { userId: true },
  },
  pollVotes: {
    where: { userId: currentUserId },
    select: { optionId: true, userId: true },
  },
  _count: { select: { saved_posts: true } },
});

async function selectHomeFeedAdPlacements(
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

const feedCacheTags = (...tags: Array<string | null | undefined>): string[] => {
  const dynamicTags = tags.filter((tag): tag is string => Boolean(tag));
  return Array.from(new Set([HOME_FEED_CACHE_GLOBAL_TAG, ...dynamicTags]));
};

async function enqueuePostCreatedFollowerFeedInvalidation(postId: string, authorId: string): Promise<void> {
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

function buildHomeFeedCacheKey(params: {
  userId: string;
  cursor: string;
  limit: number;
  mode: 'latest' | 'recommended';
}): string {
  return [
    'posts:feed',
    HOME_FEED_CACHE_VERSION,
    `user:${params.userId}`,
    `mode:${params.mode}`,
    `limit:${params.limit}`,
    `cursor:${params.cursor || 'first'}`,
  ].join(':');
}

function buildFeedRecommendationContextCacheKey(userId: string): string {
  return `posts:feed:recommendation-context:${HOME_FEED_CACHE_VERSION}:${userId}`;
}

function shouldBypassHomeFeedCache(req: Request): boolean {
  const cacheControl = String(req.headers['cache-control'] || '').toLowerCase();
  return (
    cacheControl.includes('no-cache') ||
    Boolean(ensureString(req.query.cacheBust)) ||
    Boolean(ensureString(req.query._t))
  );
}

function writeRecommendedFeedImpressions(currentUserId: string, postIds: string[]): void {
  const feedImpressionsModel = (prisma as any).feed_impressions;
  const uniquePostIds = Array.from(new Set(postIds.filter(Boolean)));
  if (!feedImpressionsModel || uniquePostIds.length === 0) return;

  const now = new Date();
  const shouldRunCleanup = now.getTime() - lastFeedImpressionCleanupAt > FEED_IMPRESSION_CLEANUP_INTERVAL_MS;
  if (shouldRunCleanup) {
    lastFeedImpressionCleanupAt = now.getTime();
  }

  // Fire-and-forget: never block feed response on impression writes.
  void (async () => {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "feed_impressions" ("id", "userId", "postId", "seenAt")
        VALUES ${Prisma.join(
          uniquePostIds.map((postId) => Prisma.sql`(${randomUUID()}, ${currentUserId}, ${postId}, ${now})`)
        )}
        ON CONFLICT ("userId", "postId")
        DO UPDATE SET "seenAt" = EXCLUDED."seenAt"
      `
    );

    if (shouldRunCleanup) {
      await feedImpressionsModel.deleteMany({
        where: { seenAt: { lt: new Date(now.getTime() - FEED_IMPRESSION_LOOKBACK_MS) } },
      });
    }
  })().catch((impressionError: unknown) => {
    console.error('Failed to write feed impressions:', impressionError);
  });
}

const getPostRealtimeRooms = (postId: string, visibility?: string | null): string[] => (
  String(visibility || 'public').toLowerCase() === 'public'
    ? [FEED_REALTIME_ROOM, `post:${postId}`]
    : [`post:${postId}`]
);

function buildMetadataFromRequest(
  body: Record<string, unknown>,
  mappedType: string,
  mediaUrls: string[]
): StoredPostMetadata | null {
  const metadata: StoredPostMetadata = {};
  const mentions = parseStringArrayField(body.mentions);
  const collaboratorIds = parseStringArrayField(body.collaboratorIds);
  const music = parseStoredMusicAttachment(body.music);

  if (mentions.length > 0) {
    metadata.mentions = mentions;
  }

  if (collaboratorIds.length > 0) {
    metadata.pendingCollaboratorIds = collaboratorIds;
  }

  if (music) {
    metadata.music = music;
  }

  const defaultVideoId = ensureString(body.defaultVideoId);
  if (defaultVideoId) {
    metadata.defaultVideoId = defaultVideoId;
  }

  if (mappedType === 'video' && mediaUrls[0]) {
    metadata.videoUrl = mediaUrls[0];
  }

  if (mappedType === 'link') {
    const linkUrl = normalizeUrl(body.linkUrl);
    if (!linkUrl) {
      throw new Error('VALIDATION:Link URL is required');
    }

    metadata.linkUrl = linkUrl;
    metadata.linkTitle = ensureString(body.linkTitle) || extractDomain(linkUrl) || linkUrl;
    metadata.linkDescription = ensureString(body.linkDescription) || null;
    metadata.linkImage = normalizeUrl(body.linkImage);
    metadata.linkDomain = extractDomain(linkUrl);
  }

  if (mappedType === 'poll') {
    const optionTexts = parseStringArrayField(body.pollOptions).slice(0, 6);
    if (optionTexts.length < 2) {
      throw new Error('VALIDATION:At least 2 poll options are required');
    }

    const pollDuration = Math.max(1, parseNumberField(body.pollDuration) ?? 24);
    metadata.pollDuration = pollDuration;
    metadata.pollEndsAt = new Date(Date.now() + pollDuration * 60 * 60 * 1000).toISOString();
    metadata.showResultsBeforeVote = parseBooleanField(body.showResultsBeforeVote, false);
    metadata.pollOptions = optionTexts.map((text) => ({
      id: randomUUID(),
      text,
      votes: 0,
    }));
  }

  if (mappedType === 'article') {
    const articleTitle = ensureString(body.articleTitle);
    if (!articleTitle) {
      throw new Error('VALIDATION:Article title is required');
    }

    metadata.articleTitle = articleTitle;
    metadata.articleTags = parseStringArrayField(body.articleTags);
    metadata.articleCoverImage = mediaUrls[0] || null;
    metadata.articleReadTime = Math.max(
      1,
      Math.ceil((ensureString(body.content)?.split(/\s+/).length ?? 0) / 200)
    );
  }

  if (mappedType === 'celebration') {
    const celebrationType = ensureString(body.celebrationType);
    if (!celebrationType) {
      throw new Error('VALIDATION:Celebration type is required');
    }

    metadata.celebrationType = celebrationType;
    const celebrationBadge = ensureString(body.celebrationBadge);
    if (celebrationBadge) {
      metadata.celebrationBadge = celebrationBadge;
    }
    if (mediaUrls[0]) {
      metadata.celebrationGifUrl = mediaUrls[0];
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function parseDirectMediaField(value: unknown): FinalizedDirectMedia[] {
  const parsed = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return [];
        }
      })()
    : value;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is FinalizedDirectMedia => Boolean(item && typeof item === 'object'))
    .slice(0, 10);
}

async function validateDirectPostMedia(
  userId: string,
  value: unknown
): Promise<Array<FinalizedDirectMedia & { url: string }>> {
  const media = parseDirectMediaField(value);
  const validated: Array<FinalizedDirectMedia & { url: string }> = [];

  for (const item of media) {
    if (!item.objectKey || !item.token || !item.mimeType || !Number.isFinite(Number(item.sizeBytes))) {
      throw new Error('Invalid direct media payload');
    }

    const url = await validateFinalizedStorageMedia({
      userId,
      token: String(item.token),
      objectKey: String(item.objectKey),
      mimeType: String(item.mimeType),
      sizeBytes: Number(item.sizeBytes),
      purpose: 'post_media',
    });

    validated.push({
      ...item,
      url,
      sizeBytes: Number(item.sizeBytes),
    });
  }

  return validated;
}

export const getPostUploadUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const mimeType = ensureString(req.body?.mimeType);
    const sizeBytes = Number(req.body?.sizeBytes);
    if (!mimeType || !Number.isFinite(sizeBytes)) {
      res.status(400).json({ error: 'mimeType and sizeBytes are required' });
      return;
    }

    const credential = createStorageUploadIntent({
      userId: String(req.user.userId),
      purpose: 'post_media',
      mimeType,
      sizeBytes,
    });

    res.json({
      provider: 'bunny_storage',
      uploadMethod: 'PUT',
      uploadUrl: credential.uploadUrl,
      uploadHeaders: credential.headers,
      objectKey: credential.objectKey,
      cdnUrl: credential.cdnUrl,
      uploadToken: credential.token,
      expiresAt: credential.intent.expiresAt,
      maxBytes: credential.intent.maxBytes,
      mimeType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to issue upload credential';
    res.status(message.includes('large') || message.includes('Unsupported') ? 400 : 500).json({ error: message });
  }
};

function compactStringList(values: unknown[]): string[] {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function connectionPeerIds(
  rows: Array<{ requesterId?: string | null; addresseeId?: string | null }>,
  currentUserId: string
): string[] {
  return Array.from(
    new Set(
      rows
        .flatMap((connection) => [connection.requesterId, connection.addresseeId])
        .filter((userId): userId is string => Boolean(userId && userId !== currentUserId))
    )
  );
}

function recentProfileWeights(
  rows: Array<{ viewedId?: string | null }>,
  currentUserId: string
): Record<string, number> {
  const uniqueViewedIds = rows
    .map((row) => String(row.viewedId || '').trim())
    .filter((viewedId) => viewedId && viewedId !== currentUserId)
    .filter((viewedId, index, all) => all.indexOf(viewedId) === index)
    .slice(0, MAX_RECENT_PROFILE_SIGNALS);

  return Object.fromEntries(
    uniqueViewedIds.map((viewedId, index) => [
      viewedId,
      Math.max(1, MAX_RECENT_PROFILE_SIGNALS - index),
    ])
  );
}

async function buildFeedRecommendationContextForUser(currentUserId: string) {
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

function collectOwnedPostMediaUrls(post: { mediaUrls?: string[] | null; metadata?: unknown }, userId: string): string[] {
  const metadata = getPostMetadata(post.metadata);
  const candidates = [
    ...(Array.isArray(post.mediaUrls) ? post.mediaUrls : []),
    metadata.videoUrl,
    metadata.videoThumbnail,
    metadata.documentUrl,
    metadata.documentThumbnail,
    metadata.articleCoverImage,
    metadata.celebrationGifUrl,
  ];

  return Array.from(new Set(
    candidates
      .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
      .filter((url) => {
        try {
          return bunnyStorageService.isUserOwnedPath(url, userId);
        } catch {
          return false;
        }
      })
  ));
}

async function deleteOwnedPostMedia(urls: string[]): Promise<void> {
  const results = await Promise.allSettled(
    urls.map((url) => bunnyStorageService.deleteFile(url))
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn('Failed to delete post media from storage:', {
        url: urls[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}

// Get feed
export const getFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const requestStartedAtMs = Date.now();
    const cursor = ensureString(req.query.cursor);
    const requestedLimit = parseInt(ensureString(req.query.limit) || String(HOME_FEED_DEFAULT_LIMIT), 10);
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? requestedLimit : HOME_FEED_DEFAULT_LIMIT, 1),
      HOME_FEED_MAX_LIMIT
    );
    const modeRaw = (ensureString(req.query.mode) || 'recommended').toLowerCase();
    const mode: 'latest' | 'recommended' = modeRaw === 'latest' ? 'latest' : 'recommended';
    const adSessionId = ensureString(req.query.adSessionId);
    const requestedAdItemOffset = parseInt(ensureString(req.query.adItemOffset) || '0', 10);
    const adItemOffset = Math.min(Math.max(Number.isFinite(requestedAdItemOffset) ? requestedAdItemOffset : 0, 0), 10000);
    const recommendedCursorState =
      mode === 'recommended'
        ? decodeRecommendedFeedCursor(cursor, requestStartedAtMs)
        : null;
    const recommendationSessionStartedAtMs =
      recommendedCursorState?.sessionStartedAtMs ?? requestStartedAtMs;
    const dbCursor =
      mode === 'recommended'
        ? recommendedCursorState?.baseCursor
        : null;
    const latestCursor =
      mode === 'latest'
        ? decodeKeysetCursor(cursor, 'feed.latest')
        : null;
    const latestCursorWhere = createdAtDescKeysetWhere(latestCursor);
    const candidateLimit =
      mode === 'recommended'
        ? recommendedFeedCandidateLimit(limit)
        : limit;
    const bypassFeedCache = shouldBypassHomeFeedCache(req);
    const cacheCursor =
      mode === 'recommended'
        ? cursor
        : cursor;
    const feedCacheKey = buildHomeFeedCacheKey({
      userId: currentUserId,
      cursor: cacheCursor || '',
      limit,
      mode,
    });
    const blockedUserIds = await getBlockedUserIds(currentUserId);
    const blockedUserIdSet = new Set(blockedUserIds);

    const computeFeedPayload = async () => {
      const accessWhere = await buildPostVisibilityWhere(currentUserId);

      const postsPromise = prismaRead.post.findMany({
        where: {
          isActive: true,
          ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
          ...accessWhere,
          ...(mode === 'recommended'
            ? { createdAt: { lte: new Date(recommendationSessionStartedAtMs + 5_000) } }
            : {}),
          ...(mode === 'latest' && latestCursorWhere ? { AND: [latestCursorWhere] } : {}),
        },
        include: postResponseInclude(currentUserId, { authorProfileSignals: mode === 'recommended' }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: candidateLimit + 1,
        ...(dbCursor ? { cursor: { id: dbCursor }, skip: 1 } : {}),
      });

      const feedImpressionsModel = (prismaRead as any).feed_impressions;
      const recommendationContextPromise =
        mode === 'recommended'
          ? buildFeedRecommendationContextForUser(currentUserId)
          : Promise.resolve(null);

      const [posts, recommendationContext] = await Promise.all([
        postsPromise,
        recommendationContextPromise,
      ]);

      const hasMoreChronological = posts.length > candidateLimit;
      const rawChronologicalItems = hasMoreChronological ? posts.slice(0, candidateLimit) : posts;
      const authorVisibilityByUser = await getPremiumVisibilityByUserIds(
        rawChronologicalItems.map((post) => post.authorId)
      );
      const chronologicalItems = rawChronologicalItems.map((post) => ({
        ...post,
        author: post.author
          ? applyPremiumVisibilityToUser(post.author, authorVisibilityByUser)
          : post.author,
      }));

      const impressions =
        mode === 'recommended' && feedImpressionsModel && chronologicalItems.length > 0
          ? await feedImpressionsModel.findMany({
              where: {
                userId: currentUserId,
                postId: { in: chronologicalItems.map((post) => post.id) },
                seenAt: { gte: new Date(Date.now() - FEED_IMPRESSION_LOOKBACK_MS) },
              },
              select: { postId: true, seenAt: true },
            })
          : [];
      const rankingImpressions = Array.isArray(impressions)
        ? impressions.filter((item: { seenAt: Date }) => {
            const seenAtMs = new Date(item.seenAt).getTime();
            return !Number.isFinite(seenAtMs) || seenAtMs < recommendationSessionStartedAtMs;
          })
        : [];

      const seenPostIds = Array.isArray(rankingImpressions)
        ? rankingImpressions.map((item: { postId: string }) => item.postId)
        : [];
      const seenAtByPostId = Array.isArray(rankingImpressions)
        ? Object.fromEntries(
            rankingImpressions.map((item: { postId: string; seenAt: Date }) => [item.postId, item.seenAt])
          )
        : {};

      let pageItems = chronologicalItems;
      let nextCursor: string | null = null;
      let hasMore = hasMoreChronological;
      if (mode === 'recommended') {
        try {
          const rankedPage = rankFeedPage(chronologicalItems, {
            ...(recommendationContext || {}),
            seenPostIds,
            seenAtByPostId,
            nowMs: recommendationSessionStartedAtMs,
          }, {
            limit,
            cursorState: recommendedCursorState || undefined,
            hasMoreChronological,
            chronologicalBoundaryCursor: chronologicalItems[chronologicalItems.length - 1]?.id || null,
          });
          pageItems = rankedPage.items;
          nextCursor = rankedPage.nextCursor;
          hasMore = rankedPage.hasMore;
        } catch (rankingError) {
          console.error('Feed ranking failed, falling back to latest ordering:', rankingError);
          pageItems = chronologicalItems.slice(0, limit);
          nextCursor =
            hasMoreChronological || chronologicalItems.length > pageItems.length
              ? pageItems[pageItems.length - 1]?.id || null
              : null;
          hasMore = Boolean(nextCursor);
        }
      } else {
        pageItems = chronologicalItems.slice(0, limit);
        const lastItem = pageItems[pageItems.length - 1];
        nextCursor = hasMoreChronological && lastItem
          ? encodeKeysetCursor({ scope: 'feed.latest', id: lastItem.id, t: new Date(lastItem.createdAt).toISOString() })
          : null;
      }

      return {
        posts: pageItems.map((post) => mapPostResponse(post, currentUserId)),
        nextCursor,
        hasMore,
      };
    };

    const feedPayload = bypassFeedCache
      ? await computeFeedPayload()
      : await cacheService.getOrSet(feedCacheKey, computeFeedPayload, {
          tags: feedCacheTags(`feed:${currentUserId}`),
          swr: {
            softTtlSeconds: HOME_FEED_CACHE_TTL_SECONDS,
            hardTtlSeconds: HOME_FEED_CACHE_TTL_SECONDS * 4,
          },
        });
    const filteredPosts = feedPayload.posts.filter((post) => {
      const authorId = post.authorId || post.author?.id;
      return !authorId || !blockedUserIdSet.has(String(authorId));
    });

    const adPlacements = await selectHomeFeedAdPlacements(
      currentUserId,
      filteredPosts.length,
      adItemOffset,
      adSessionId
    );

    const responsePayload = {
      ...feedPayload,
      posts: filteredPosts,
      adPlacements,
    };

    res.setHeader('X-Vormex-Cache', bypassFeedCache ? 'BYPASS' : 'MISS');
    res.json(responsePayload);

    if (mode === 'recommended' && filteredPosts.length > 0) {
      writeRecommendedFeedImpressions(currentUserId, filteredPosts.map((post) => post.id));
    }
  } catch (error) {
    console.error('getFeed error:', error);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
};

// Get single post
export const getPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: {
        id: postId,
        isActive: true,
        ...(await buildPostVisibilityWhere(currentUserId)),
      },
      include: postResponseInclude(currentUserId),
    });

    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    res.status(200).json(mapPostResponse(post, currentUserId));
  } catch (error) {
    console.error('getPost error:', error);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
};

// Create post
export const createPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const typeRaw = String(req.body.type || 'TEXT').toUpperCase();
    const visibilityRaw = String(req.body.visibility || 'PUBLIC');
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';

    const mappedType = typeRaw.toLowerCase();
    const visibility = parseVisibility(visibilityRaw);
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const imageFiles = files.filter((file) => file.mimetype?.startsWith('image/'));
    const videoFiles = files.filter((file) => file.mimetype?.startsWith('video/'));
    let directMedia: Array<FinalizedDirectMedia & { url: string }> = [];
    try {
      directMedia = await validateDirectPostMedia(userId, req.body.directMedia);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid direct media' });
      return;
    }
    const directImageCount = directMedia.filter((item) => item.mimeType.startsWith('image/')).length;
    const directVideoCount = directMedia.filter((item) => item.mimeType.startsWith('video/')).length;

    if (mappedType === 'text' && !content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    if (mappedType === 'image' && imageFiles.length + directImageCount === 0) {
      res.status(400).json({ error: 'At least one image is required' });
      return;
    }

    if (mappedType === 'video' && videoFiles.length + directVideoCount === 0) {
      res.status(400).json({ error: 'A video file is required' });
      return;
    }

    if (mappedType === 'link' && !normalizeUrl(req.body.linkUrl)) {
      res.status(400).json({ error: 'Link URL is required' });
      return;
    }

    if (mappedType === 'poll' && parseStringArrayField(req.body.pollOptions).length < 2) {
      res.status(400).json({ error: 'At least 2 poll options are required' });
      return;
    }

    if (mappedType === 'article' && !ensureString(req.body.articleTitle)) {
      res.status(400).json({ error: 'Article title is required' });
      return;
    }

    if (mappedType === 'celebration' && !ensureString(req.body.celebrationType)) {
      res.status(400).json({ error: 'Celebration type is required' });
      return;
    }

    await enforceTrustTierLimit(userId, 'post');
    if (files.length > 0 || directMedia.length > 0) {
      await enforceTrustTierLimit(userId, 'media');
    }

    const mediaUrls: string[] = directMedia.map((item) => item.url);

    // Upload images/videos to Bunny.net CDN
    if (files.length > 0) {
      if (!process.env.BUNNY_STORAGE_API_KEY) {
        res.status(500).json({ error: 'Media storage is not configured. Please contact support.' });
        return;
      }
      
      try {
        for (let i = 0; i < imageFiles.length; i++) {
          const url = await bunnyStorageService.uploadPostImage(
            imageFiles[i].buffer,
            userId,
            i,
            imageFiles[i].mimetype || 'image/jpeg'
          );
          mediaUrls.push(url);
        }
        for (const v of videoFiles) {
          const url = await bunnyStorageService.uploadPostVideo(
            v.buffer,
            userId,
            v.mimetype || 'video/mp4'
          );
          mediaUrls.push(url);
        }
      } catch (uploadError) {
        console.error('Failed to upload media to CDN:', uploadError);
        res.status(500).json({ error: 'Failed to upload media. Please try again.' });
        return;
      }
    }

    let metadata: StoredPostMetadata | null = null;
    try {
      metadata = buildMetadataFromRequest(req.body || {}, mappedType, mediaUrls);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid post metadata';
      if (message.startsWith('VALIDATION:')) {
        res.status(400).json({ error: message.replace('VALIDATION:', '') });
        return;
      }
      throw error;
    }

    if (metadata && mappedType === 'link') {
      await enrichLinkMetadataFromUrl(metadata);
    }

    const requestedCollaboratorIds = Array.from(new Set(parseStringArrayField(metadata?.pendingCollaboratorIds)))
      .filter((collaboratorId) => collaboratorId && collaboratorId !== userId)
      .slice(0, 30);
    const validCollaboratorIds =
      requestedCollaboratorIds.length > 0
        ? (
            await prismaRead.user.findMany({
              where: {
                id: { in: requestedCollaboratorIds },
                isBanned: false,
              },
              select: { id: true },
            })
          ).map((user) => user.id)
        : [];

    if (metadata?.pendingCollaboratorIds) {
      metadata.pendingCollaboratorIds = validCollaboratorIds;
    }

    const peerIds =
      visibility === 'connections'
        ? Array.from(
            new Set(
              (
                await prismaRead.connections.findMany({
                  where: {
                    status: 'accepted',
                    OR: [{ requesterId: userId }, { addresseeId: userId }],
                  },
                  select: { requesterId: true, addresseeId: true },
                })
              ).flatMap((connection) => [connection.requesterId, connection.addresseeId])
            )
          ).filter((peerId) => peerId !== userId)
        : [];

	    const created = await prisma.$transaction(async (tx) => {
      const nextPost = await tx.post.create({
        data: {
          authorId: userId,
          content: content || '',
          type: mappedType,
          visibility,
          mediaUrls,
          metadata,
        },
        include: postResponseInclude(userId),
      });

      if (validCollaboratorIds.length > 0) {
        await (tx as any).postCollaborator.createMany({
          data: validCollaboratorIds.map((collaboratorId) => ({
            id: randomUUID(),
            postId: nextPost.id,
            userId: collaboratorId,
            invitedById: userId,
            status: 'pending',
          })),
          skipDuplicates: true,
        });
      }

      const mappedPost = mapPostResponse(nextPost, userId);
      const envelopes: Array<Record<string, unknown>> = [
        {
          event: 'streak:updated',
          users: [userId],
          payload: { type: 'posting' },
        },
      ];

      if (visibility === 'public') {
        envelopes.push({
          event: 'post:created',
          rooms: [FEED_REALTIME_ROOM],
          payload: { post: mappedPost },
        });
      } else if (visibility === 'connections') {
        envelopes.push({
          event: 'post:created',
          users: [userId, ...peerIds],
          payload: { post: mappedPost },
        });
      } else {
        envelopes.push({
          event: 'post:created',
          users: [userId],
          payload: { post: mappedPost },
        });
      }

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: nextPost.id,
        eventType: 'post.created.fanout',
        envelopes: envelopes as any,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: nextPost.id,
        eventType: 'post.created.cache.invalidate',
        tags: feedCacheTags(`feed:${userId}`, `user:${userId}`),
      });

      return nextPost;
    });

    await enqueuePostCreatedFollowerFeedInvalidation(created.id, userId);

    // Record activity and update posting streak (non-blocking)
    const activityType = mappedType === 'article' ? 'article' : 'post';
    recordActivity(userId, activityType, 1, { sourceId: created.id }).catch(console.error);
    updateEngagementStreak(userId, 'posting').catch(console.error);

    const collaboratorIds = validCollaboratorIds;
    const collaboratorIdSet = new Set(collaboratorIds);
    const mentionedUserIds = Array.from(new Set(parseStringArrayField(metadata?.mentions)))
      .filter((mentionedUserId) => mentionedUserId && mentionedUserId !== userId)
      .filter((mentionedUserId) => !collaboratorIdSet.has(mentionedUserId))
      .slice(0, 30);
    if (mentionedUserIds.length > 0 || collaboratorIds.length > 0) {
      Promise.resolve()
        .then(async () => {
          const [mentionableUsers, collaboratorUsers] = await Promise.all([
            mentionedUserIds.length > 0 ? prisma.user.findMany({
              where: {
                id: { in: mentionedUserIds },
                isBanned: false,
              },
              select: { id: true },
            }) : [],
            collaboratorIds.length > 0 ? prisma.user.findMany({
              where: {
                id: { in: collaboratorIds },
                isBanned: false,
              },
              select: { id: true },
            }) : [],
          ]);
          const mentionerName = created.author?.name || created.author?.username || 'Someone';
          const preview = content || `${mentionerName} tagged you in a ${mappedType} post`;

          await Promise.all([
            ...mentionableUsers.map((mentionedUser) =>
              notificationService.notifyMention(
                mentionedUser.id,
                userId,
                mentionerName,
                'post',
                created.id,
                preview
              )
            ),
            ...collaboratorUsers.map((collaboratorUser) =>
              notificationService.notifyPostCollabInvite(
                collaboratorUser.id,
                userId,
                mentionerName,
                created.id,
                preview
              )
            ),
          ]);
        })
        .catch(console.error);
    }

    res.status(201).json(mapPostResponse(created, userId));
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('createPost error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
};

export const finalizePostUpload = createPost;

// Update post
export const updatePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const existing = await prisma.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only edit your own posts' });
      return;
    }

    const data: { content?: string; visibility?: string } = {};
    if (typeof req.body.content === 'string') {
      data.content = req.body.content.trim();
    }
    if (typeof req.body.visibility === 'string') {
      data.visibility = parseVisibility(req.body.visibility);
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data,
      include: postResponseInclude(userId),
    });

    res.status(200).json(mapPostResponse(updated, userId));
  } catch (error) {
    console.error('updatePost error:', error);
    res.status(500).json({ error: 'Failed to update post' });
  }
};

// Accept or reject a post collaboration invite
export const respondToPostCollabInvite = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const action = ensureString(req.body?.action).toLowerCase();
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }
    if (!['accept', 'reject'].includes(action)) {
      res.status(400).json({ error: 'action must be "accept" or "reject"' });
      return;
    }

    const post = await prisma.post.findFirst({
      where: { id: postId, isActive: true },
      select: {
        id: true,
        authorId: true,
        metadata: true,
      },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    if (post.authorId === userId) {
      res.status(400).json({ error: 'You cannot respond to your own collaboration invite' });
      return;
    }

    const existingCollaboration = await (prisma as any).postCollaborator.findUnique({
      where: { postId_userId: { postId, userId } },
      select: { id: true, status: true },
    }).catch(() => null);
    const rawMetadata =
      post.metadata && typeof post.metadata === 'object' && !Array.isArray(post.metadata)
        ? { ...(post.metadata as Record<string, unknown>) }
        : {};
    const pendingFromMetadata = [
      ...parseStringArrayField(rawMetadata.pendingCollaboratorIds),
      ...parseStringArrayField(rawMetadata.collaboratorIds),
    ];
    const wasInvited = Boolean(existingCollaboration) || pendingFromMetadata.includes(userId);
    if (!wasInvited) {
      res.status(404).json({ error: 'Collaboration invite not found' });
      return;
    }

    const nextStatus = action === 'accept' ? 'accepted' : 'rejected';
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await (tx as any).postCollaborator.upsert({
        where: { postId_userId: { postId, userId } },
        create: {
          id: randomUUID(),
          postId,
          userId,
          invitedById: post.authorId,
          status: nextStatus,
          respondedAt: now,
        },
        update: {
          status: nextStatus,
          respondedAt: now,
        },
      });

      const metadata = { ...rawMetadata };
      const pendingCollaboratorIds = parseStringArrayField(metadata.pendingCollaboratorIds)
        .filter((collaboratorId) => collaboratorId !== userId);
      const collaboratorIds = parseStringArrayField(metadata.collaboratorIds)
        .filter((collaboratorId) => collaboratorId !== userId);
      if (nextStatus === 'accepted') {
        collaboratorIds.push(userId);
      }
      metadata.pendingCollaboratorIds = Array.from(new Set(pendingCollaboratorIds));
      metadata.collaboratorIds = Array.from(new Set(collaboratorIds));

      await tx.post.update({
        where: { id: postId },
        data: { metadata },
      });

      const inviteNotifications = await tx.notifications.findMany({
        where: {
          userId,
          postId,
          type: 'mention',
        },
        select: {
          id: true,
          data: true,
        },
      });

      await Promise.all(
        inviteNotifications
          .filter((notification) => {
            const data = notification.data as Record<string, unknown> | null;
            return data?.context === 'post_collab_invite';
          })
          .map((notification) => {
            const data = (notification.data || {}) as Record<string, unknown>;
            return tx.notifications.update({
              where: { id: notification.id },
              data: {
                isRead: true,
                readAt: now,
                data: {
                  ...data,
                  collabStatus: nextStatus,
                  respondedAt: now.toISOString(),
                },
              },
            });
          })
      );
    });

    await cacheService.invalidateTags(
      HOME_FEED_CACHE_GLOBAL_TAG,
      `feed:${userId}`,
      `user:${userId}`,
      `user:${post.authorId}`,
      `notifications:${userId}`
    ).catch(() => undefined);

    if (nextStatus === 'accepted') {
      const collaborator = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true },
      });
      const collaboratorName = collaborator?.name || collaborator?.username || 'Someone';
      notificationService.createNotification({
        userId: post.authorId,
        type: 'mention',
        title: '🤝 Collaboration accepted',
        body: `${collaboratorName} accepted your post collaboration invite`,
        actorId: userId,
        postId,
        data: {
          type: 'mention',
          screen: 'post',
          context: 'post_collab_accepted',
          actorId: userId,
          postId,
        },
      }).catch(() => undefined);
    }

    const updatedPost = await prisma.post.findUnique({
      where: { id: postId },
      include: postResponseInclude(userId),
    });

    res.status(200).json({
      success: true,
      status: nextStatus,
      post: updatedPost ? mapPostResponse(updatedPost, userId) : null,
    });
  } catch (error) {
    console.error('respondToPostCollabInvite error:', error);
    res.status(500).json({ error: 'Failed to respond to collaboration invite' });
  }
};

// Delete post
export const deletePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const existing = await prisma.post.findFirst({
      where: { id: postId, isActive: true },
      select: {
        id: true,
        authorId: true,
        mediaUrls: true,
        metadata: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own posts' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: { isActive: false },
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.deleted.cache.invalidate',
        tags: feedCacheTags(`feed:${userId}`, `user:${userId}`),
      });
    });

    const mediaUrls = collectOwnedPostMediaUrls(existing, userId);
    if (mediaUrls.length > 0) {
      await deleteOwnedPostMedia(mediaUrls);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('deletePost error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
};

// Toggle like
export const toggleLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const liker = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const { liked, likesCount } = await prisma.$transaction(async (tx) => {
      const existingLike = await tx.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      });

      let nextLiked = false;
      if (existingLike) {
        await tx.postLike.delete({
          where: { postId_userId: { postId, userId } },
        });
      } else {
        await tx.postLike.create({
          data: { postId, userId },
        });
        nextLiked = true;
      }

      const nextLikesCount = await tx.postLike.count({ where: { postId } });
      await tx.post.update({
        where: { id: postId },
        data: { likesCount: nextLikesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.like.fanout',
        envelopes: [
          {
            event: 'post:liked',
            rooms: getPostRealtimeRooms(postId, post.visibility),
            payload: {
              postId,
              userId,
              liked: nextLiked,
              likesCount: nextLikesCount,
              reactionType: nextLiked ? 'LIKE' : null,
              reactionSummary: [],
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.like.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      if (nextLiked && post.authorId !== userId) {
        await enqueueNotificationDelivery(tx as any, {
          aggregateType: 'post',
          aggregateId: postId,
          eventType: 'post.like.push',
          payload: {
            kind: 'generic',
            userId: post.authorId,
            title: '❤️ New Like',
            body: `${liker?.name || 'Someone'} liked your post`,
            data: {
              type: 'like',
              postId,
              actorId: userId,
              screen: 'post',
            },
          },
        });
      }

      return { liked: nextLiked, likesCount: nextLikesCount };
    });

    // Send notification on like (not unlike)
    if (liked) {
      // Get post author and liker info
      if (post.authorId !== userId) {
        // Send in-app notification (non-blocking)
        notificationService.notifyPostLike(
          post.authorId,
          userId,
          liker?.name || 'Someone',
          postId
        ).catch(console.error);
      }
    }

    res.json({ liked, likesCount });
  } catch (error) {
    console.error('toggleLike error:', error);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
};

// Vote poll
export const votePoll = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const optionId = ensureString(req.body?.optionId);

    if (!postId || !optionId) {
      res.status(400).json({ error: 'Post ID and option ID are required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      include: {
        pollVotes: {
          where: { userId },
          select: { optionId: true, userId: true },
        },
      },
    });

    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const metadata = (post.metadata || {}) as StoredPostMetadata;
    const storedOptions = Array.isArray(metadata.pollOptions) ? metadata.pollOptions : [];
    if (storedOptions.length === 0) {
      res.status(400).json({ error: 'This post is not a poll' });
      return;
    }

    if (metadata.pollEndsAt && new Date(metadata.pollEndsAt) < new Date()) {
      res.status(400).json({ error: 'This poll has ended' });
      return;
    }

    const selectedOption = storedOptions.find((option) => option.id === optionId);
    if (!selectedOption) {
      res.status(400).json({ error: 'Poll option not found' });
      return;
    }

    const existingVote = await prismaRead.postPollVote.findUnique({
      where: { postId_userId: { postId, userId } },
    });
    if (existingVote) {
      res.status(400).json({ error: 'You have already voted on this poll' });
      return;
    }

    const pollOptions = await prisma.$transaction(async (tx) => {
      await tx.postPollVote.create({
        data: { postId, userId, optionId },
      });

      const updatedOptions = storedOptions.map((option) =>
        option.id === optionId
          ? { ...option, votes: Math.max(0, Number(option.votes || 0)) + 1 }
          : { ...option, votes: Math.max(0, Number(option.votes || 0)) }
      );

      const updatedMetadata: StoredPostMetadata = {
        ...metadata,
        pollOptions: updatedOptions,
      };

      await tx.post.update({
        where: { id: postId },
        data: { metadata: updatedMetadata },
      });

      const nextPollOptions = mapPollOptionsForResponse(updatedOptions, optionId);

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.poll.updated',
        envelopes: [
          {
            event: 'poll:updated',
            rooms: getPostRealtimeRooms(postId, post.visibility),
            payload: {
              postId,
              voterId: userId,
              votedOptionId: optionId,
              pollOptions: nextPollOptions,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.poll.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      return nextPollOptions;
    });

    res.json({
      success: true,
      pollOptions,
      userVotedOptionId: optionId,
    });
  } catch (error) {
    console.error('votePoll error:', error);
    res.status(500).json({ error: 'Failed to vote on poll' });
  }
};

// Get comments
export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const currentUserId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const parentId = ensureString(req.query.parentId) || undefined;
    const page = Math.max(1, parseInt(ensureString(req.query.page) || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(ensureString(req.query.limit) || '20', 10)));

    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, currentUserId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const where = { postId: postId as string, parentId: parentId || null };
    const [comments, total] = await Promise.all([
      prismaRead.post_comments.findMany({
        where,
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              isVerified: true,
              profileBadgeStyle: true,
            },
          },
          _count: { select: { other_post_comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit + 1,
      }),
      prismaRead.post_comments.count({ where }),
    ]);

    // Fetch current user's likes for these comments (separate query to avoid filtered relation issues)
    const commentIds = comments.map((c) => c.id);
    const userLikes = commentIds.length > 0
      ? await prismaRead.comment_likes.findMany({
          where: { commentId: { in: commentIds }, userId: currentUserId },
          select: { commentId: true },
        })
      : [];
    const likedCommentIds = new Set(userLikes.map((l) => l.commentId));

    const hasMore = comments.length > limit;
    const items = hasMore ? comments.slice(0, limit) : comments;
    
    // Fetch replies for top-level comments (only if not fetching replies specifically)
    const topLevelCommentIds = items.map((c) => c.id);
    let repliesMap: Map<string, typeof items> = new Map();
    
    if (!parentId && topLevelCommentIds.length > 0) {
      const replies = await prismaRead.post_comments.findMany({
        where: { postId: postId as string, parentId: { in: topLevelCommentIds } },
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              isVerified: true,
              profileBadgeStyle: true,
            },
          },
          _count: { select: { other_post_comments: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100, // Limit total replies fetched
      });
      
      // Get likes for replies too
      const replyIds = replies.map((r) => r.id);
      if (replyIds.length > 0) {
        const replyLikes = await prismaRead.comment_likes.findMany({
          where: { commentId: { in: replyIds }, userId: currentUserId },
          select: { commentId: true },
        });
        replyLikes.forEach((l) => likedCommentIds.add(l.commentId));
      }
      
      // Group replies by parent
      replies.forEach((r) => {
        if (r.parentId) {
          const existing = repliesMap.get(r.parentId) || [];
          existing.push(r);
          repliesMap.set(r.parentId, existing);
        }
      });
    }
    
    // Helper to map a comment
    const mapComment = (c: typeof items[0], includeReplies: boolean = false): Record<string, unknown> => {
      const cWithRelations = c as typeof c & { users: unknown; _count: { other_post_comments: number } };
      const author = cWithRelations.users ?? {
        id: c.authorId,
        username: 'unknown',
        name: 'Unknown User',
        profileImage: null,
      };
      
      const mapped: Record<string, unknown> = {
        id: c.id,
        postId: c.postId,
        parentId: c.parentId,
        authorId: c.authorId,
        author,
        content: c.content,
        contentType: 'text/plain',
        mentions: [],
        likesCount: c.likesCount,
        replyCount: cWithRelations._count?.other_post_comments ?? 0,
        isLiked: likedCommentIds.has(c.id),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
      
      if (includeReplies && repliesMap.has(c.id)) {
        mapped.replies = repliesMap.get(c.id)!.map((r) => mapComment(r, false));
      } else {
        mapped.replies = [];
      }
      
      return mapped;
    };

    const mapped = items.map((c) => mapComment(c, !parentId));

    res.json({ comments: mapped, total, hasMore });
  } catch (error) {
    const err = error as Error;
    console.error('getComments error:', err?.message ?? error);
    console.error('getComments stack:', err?.stack);
    const message = process.env.NODE_ENV !== 'production' && err?.message
      ? err.message
      : 'Failed to fetch comments';
    res.status(500).json({ error: message });
  }
};

// Create comment
export const createComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const { content, parentId, mentions } = req.body || {};

    if (!postId || !content || typeof content !== 'string') {
      res.status(400).json({ error: 'Post ID and content are required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    await enforceTrustTierLimit(userId, 'comment');

    if (parentId) {
      const parentComment = await prismaRead.post_comments.findFirst({
        where: { id: String(parentId), postId },
        select: { id: true },
      });
      if (!parentComment) {
        res.status(400).json({ error: 'Parent comment is invalid for this post' });
        return;
      }
    }

    const { comment, commentsCount, mapped } = await prisma.$transaction(async (tx) => {
      const nextComment = await tx.post_comments.create({
        data: {
          postId,
          authorId: userId,
          parentId: parentId || null,
          content: content.trim(),
        },
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
              isVerified: true,
              profileBadgeStyle: true,
              identityTrustLevel: true,
            },
          },
          comment_likes: {
            where: { userId },
            select: { userId: true },
          },
          _count: { select: { other_post_comments: true } },
        },
      });

      const nextCommentsCount = await tx.post_comments.count({ where: { postId, parentId: null } });
      await tx.post.update({
        where: { id: postId },
        data: { commentsCount: nextCommentsCount },
      });

      const commentWithRelations = nextComment as typeof nextComment & {
        users: unknown;
        _count: { other_post_comments: number };
      };
      const mappedComment = {
        id: nextComment.id,
        postId: nextComment.postId,
        parentId: nextComment.parentId,
        authorId: nextComment.authorId,
        author: commentWithRelations.users,
        content: nextComment.content,
        contentType: 'text/plain',
        mentions: mentions || [],
        likesCount: nextComment.likesCount,
        replyCount: commentWithRelations._count.other_post_comments,
        isLiked: false,
        createdAt: nextComment.createdAt,
        updatedAt: nextComment.updatedAt,
      };

      const envelopes: Array<Record<string, unknown>> = [
        {
          event: 'comment:created',
          rooms: [`post:${postId}`],
          payload: {
            postId,
            comment: mappedComment,
            commentsCount: nextCommentsCount,
          },
        },
      ];
      if (String(post.visibility || 'public').toLowerCase() === 'public') {
        envelopes.push({
          event: 'comment:created',
          rooms: [FEED_REALTIME_ROOM],
          payload: {
            postId,
            commentsCount: nextCommentsCount,
          },
        });
      }

      if (post.authorId !== userId) {
        envelopes.push({
          event: 'notification:comment',
          users: [post.authorId],
          payload: {
            postId,
            comment: mappedComment,
            commentsCount: nextCommentsCount,
          },
        });
      }

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: nextComment.id,
        eventType: 'post.comment.created',
        envelopes: envelopes as any,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.comment.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      return {
        comment: nextComment,
        commentsCount: nextCommentsCount,
        mapped: mappedComment,
      };
    });

    if (post.authorId !== userId) {
      notificationService.notifyPostComment(
        post.authorId,
        userId,
        ((comment as typeof comment & { users: { name: string | null } }).users?.name) ?? 'Someone',
        postId,
        mapped.id,
        content.trim()
      ).catch(console.error);
    }

    // Record comment activity (non-blocking)
    recordActivity(userId, 'comment', 1, { sourceId: mapped.id }).catch(console.error);

    res.status(201).json(mapped);
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('createComment error:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
};

// Toggle comment like
export const toggleCommentLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const commentId = ensureString(req.params.commentId);

    if (!postId || !commentId) {
      res.status(400).json({ error: 'Post ID and comment ID are required' });
      return;
    }

    const comment = await prismaRead.post_comments.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        postId: true,
        posts: {
          select: { id: true, authorId: true, visibility: true, isActive: true },
        },
      },
    });

    if (!comment || comment.postId !== postId || !(await canViewPost(comment.posts, userId))) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const existing = await prismaRead.comment_likes.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });

    const { liked, likesCount } = await prisma.$transaction(async (tx) => {
      let nextLiked = false;
      if (existing) {
        await tx.comment_likes.delete({
          where: { commentId_userId: { commentId, userId } },
        });
      } else {
        await tx.comment_likes.create({
          data: { commentId, userId },
        });
        nextLiked = true;
      }

      const nextLikesCount = await tx.comment_likes.count({ where: { commentId } });
      await tx.post_comments.update({
        where: { id: commentId },
        data: { likesCount: nextLikesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: commentId,
        eventType: 'post.comment.like',
        envelopes: [
          {
            event: 'comment:liked',
            rooms: [`post:${postId}`],
            payload: {
              commentId,
              postId,
              userId,
              liked: nextLiked,
              likesCount: nextLikesCount,
            },
          },
        ],
      });

      return { liked: nextLiked, likesCount: nextLikesCount };
    });

    res.json({ isLiked: liked, liked, likesCount });
  } catch (error) {
    console.error('toggleCommentLike error:', error);
    res.status(500).json({ error: 'Failed to toggle comment like' });
  }
};

// Delete comment (author only)
export const deleteComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const commentId = ensureString(req.params.commentId);

    if (!postId || !commentId) {
      res.status(400).json({ error: 'Post ID and Comment ID are required' });
      return;
    }

    const comment = await prismaRead.post_comments.findUnique({
      where: { id: commentId },
      select: { authorId: true, postId: true, parentId: true },
    });

    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    if (comment.postId !== postId) {
      res.status(400).json({ error: 'Comment does not belong to this post' });
      return;
    }

    if (comment.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own comments' });
      return;
    }

    const postRecord = await prismaRead.post.findUnique({
      where: { id: postId },
      select: { authorId: true, visibility: true },
    });

    const commentsCount = await prisma.$transaction(async (tx) => {
      await tx.post_comments.delete({ where: { id: commentId } });

      const nextCommentsCount = await tx.post_comments.count({ where: { postId, parentId: null } });
      await tx.post.update({
        where: { id: postId },
        data: { commentsCount: nextCommentsCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: commentId,
        eventType: 'post.comment.deleted',
        envelopes: [
          {
            event: 'comment:deleted',
            rooms: getPostRealtimeRooms(postId, postRecord?.visibility),
            payload: { postId, commentId, commentsCount: nextCommentsCount },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.comment.deleted.cache.invalidate',
        tags: feedCacheTags(`feed:${postRecord?.authorId || userId}`, `user:${postRecord?.authorId || userId}`),
      });

      return nextCommentsCount;
    });

    res.json({ success: true, commentsCount });
  } catch (error) {
    console.error('deleteComment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

// Share post
export const sharePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const postId = ensureString(req.params.postId);
    // targetUserId from req.body can be used to send DM/notification when implemented

    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true, sharesCount: true },
    });
    if (!post || !(await canViewPost(post, String(req.user.userId)))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const sharesCount = await prisma.$transaction(async (tx) => {
      const nextSharesCount = (post.sharesCount || 0) + 1;
      await tx.post.update({
        where: { id: postId },
        data: { sharesCount: nextSharesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.shared',
        envelopes: [
          {
            event: 'post:shared',
            rooms: getPostRealtimeRooms(postId, post.visibility),
            payload: {
              postId,
              userId: String(req.user!.userId),
              sharesCount: nextSharesCount,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.shared.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      return nextSharesCount;
    });

    const frontendUrl = process.env.FRONTEND_URL || 'https://vormex.com';
    res.status(200).json({
      message: 'Post shared successfully',
      sharesCount,
      shareUrl: `${frontendUrl.replace(/\/$/, '')}/post/${postId}`,
    });
  } catch (error) {
    console.error('sharePost error:', error);
    res.status(500).json({ error: 'Failed to share post' });
  }
};

// Get post likes list
export const getLikes = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const postId = ensureString(req.params.postId);
    const currentUserId = req.user?.userId ? String(req.user.userId) : null;
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });

    if (!post || !(await canViewPost(post, currentUserId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const likes = await prismaRead.postLike.findMany({
      where: { postId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            headline: true,
            isVerified: true,
            profileBadgeStyle: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.status(200).json({
      likes: likes.map((like) => {
        const likeWithUser = like as typeof like & { user: { id: string; username: string; name: string; profileImage: string | null; headline: string | null } };
        return {
          id: like.id,
          userId: likeWithUser.user.id,
          username: likeWithUser.user.username,
          name: likeWithUser.user.name,
          profileImage: likeWithUser.user.profileImage,
          headline: likeWithUser.user.headline,
          verified: Boolean((likeWithUser.user as any).isVerified),
          isVerified: Boolean((likeWithUser.user as any).isVerified),
          profileBadgeStyle: (likeWithUser.user as any).profileBadgeStyle ?? null,
          reactionType: 'LIKE',
          createdAt: like.createdAt,
        };
      }),
    });
  } catch (error) {
    console.error('getLikes error:', error);
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
};
