// @ts-nocheck
import { Request, Response } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { bunnyStreamService } from '../services/bunny-stream.service';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { getIO } from '../sockets';
import { notificationService } from '../services/notification.service';
import { recordActivity } from '../services/activity.service';
import { cacheService } from '../services/cache.service';
import { buildReelVisibilityWhere, canViewReel } from '../utils/access-control.util';
import { selectManagedAdPlacements } from '../services/managed-ad.service';
import {
  createBunnyStreamUploadIntent,
  createStorageUploadIntent,
  validateFinalizedStorageMedia,
  validateFinalizedStreamMedia,
} from '../utils/direct-media-upload.util';
import {
  clampPageSize,
  dateDescKeysetWhere,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from '../utils/keyset-pagination.util';
import { decorateSurfaceRecommendations } from '../services/surface-recommendation.service';
import { recordAuthoritativeRecommendationOutcome } from '../services/recommendation-platform.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const reelCommentAuthorSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
};

function verifyBunnyStreamSignature(req: Request): boolean {
  const secret = process.env.BUNNY_STREAM_WEBHOOK_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== 'production';
  }

  const signature = req.headers['x-bunnystream-signature'];
  const version = req.headers['x-bunnystream-signature-version'];
  const algorithm = req.headers['x-bunnystream-signature-algorithm'];
  const rawBody = (req as any).rawBody;

  if (
    version !== 'v1'
    || algorithm !== 'hmac-sha256'
    || typeof signature !== 'string'
    || !Buffer.isBuffer(rawBody)
  ) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(signature) || signature.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
}

function mapReelCommentAuthor(author: any) {
  if (!author) {
    return {
      id: '',
      username: 'unknown',
      name: 'Unknown user',
    profileImage: null,
    headline: null,
    verified: false,
    isVerified: false,
    profileBadgeStyle: null,
  };
  }

  return {
    id: author.id,
    username: author.username,
    name: author.name,
    profileImage: author.profileImage,
    headline: author.headline,
    verified: Boolean(author.isVerified),
    isVerified: Boolean(author.isVerified),
    profileBadgeStyle: author.profileBadgeStyle ?? null,
  };
}

function mapReelComment(comment: any, currentUserId?: string) {
  return {
    id: comment.id,
    reelId: comment.reelId,
    parentId: comment.parentId,
    author: mapReelCommentAuthor(comment.users),
    content: comment.content,
    mentions: comment.mentions || [],
    likesCount: comment.likesCount || 0,
    repliesCount: Math.max(comment.repliesCount || 0, comment._count?.other_reel_comments || 0),
    isLiked: currentUserId
      ? Boolean(comment.reel_comment_likes?.some((like: any) => like.userId === currentUserId))
      : false,
    isPinned: Boolean(comment.isPinned),
    isAuthorHeart: Boolean(comment.isAuthorHeart),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function normalizeMentionUsernames(content: string, mentions?: unknown): string[] {
  const fromBody = Array.isArray(mentions)
    ? mentions
    : typeof mentions === 'string'
      ? safeJsonParse<string[]>(mentions, [])
      : [];
  const fromContent = [...content.matchAll(/(^|[^A-Za-z0-9_.])@([A-Za-z0-9_][A-Za-z0-9_.-]{1,29})/g)]
    .map((match) => match[2]);

  const normalized = [...fromBody, ...fromContent]
    .map((mention) => String(mention || '').trim().replace(/^@+/, '').toLowerCase())
    .map((mention) => mention.replace(/^[^a-z0-9_]+|[^a-z0-9_.-]+$/gi, ''))
    .filter((mention) => mention.length >= 2 && mention.length <= 30);

  return Array.from(new Set(normalized)).slice(0, 30);
}

function mapReelResponse(reel: any, currentUserId?: string) {
  const author = reel.users;
  const isLiked = currentUserId
    ? Boolean((reel.reel_likes || reel.reels_likes)?.some((like: any) => like.userId === currentUserId))
    : false;
  const isSaved = currentUserId
    ? Boolean((reel.reel_saves || reel.reels_saves)?.some((save: any) => save.userId === currentUserId))
    : false;
  const userVotedOption = (reel.reel_poll_votes || reel.reels_poll_votes)?.find((v: any) => v.userId === currentUserId)?.optionId ?? null;

  return {
    id: reel.id,
    author: author
      ? {
          id: author.id,
          username: author.username,
          name: author.name,
          profileImage: author.profileImage,
          headline: author.headline,
          verified: Boolean(author.isVerified),
          isVerified: Boolean(author.isVerified),
          profileBadgeStyle: author.profileBadgeStyle ?? null,
          isFollowing: Boolean(author.follows_follows_followingIdTousers?.length),
        }
      : null,
    videoId: reel.videoId,
    videoUrl: reel.videoUrl,
    hlsUrl: reel.hlsUrl,
    thumbnailUrl: reel.thumbnailUrl,
    previewGifUrl: reel.previewGifUrl,
    title: reel.title,
    caption: reel.caption,
    durationSeconds: reel.durationSeconds,
    width: reel.width,
    height: reel.height,
    aspectRatio: reel.aspectRatio,
    audio: reel.reel_audio
      ? {
          id: reel.reel_audio.id,
          title: reel.reel_audio.title,
          artist: reel.reel_audio.artist,
          albumArt: reel.reel_audio.albumArt,
        }
      : null,
    hashtags: reel.hashtags || [],
    mentions: reel.mentions || [],
    skills: reel.skills || [],
    topics: reel.topics || [],
    category: reel.category,
    locationName: reel.locationName,
    isResponse: reel.isResponse,
    responseType: reel.responseType,
    originalReelId: reel.originalReelId,
    pollQuestion: reel.pollQuestion,
    pollOptions: reel.pollOptions,
    pollEndsAt: reel.pollEndsAt,
    userVotedOption,
    quizQuestion: reel.quizQuestion,
    quizOptions: reel.quizOptions,
    codeSnippet: reel.codeSnippet,
    codeLanguage: reel.codeLanguage,
    codeFileName: reel.codeFileName,
    repoUrl: reel.repoUrl,
    ctaType: reel.ctaType,
    ctaText: reel.ctaText,
    ctaUrl: reel.ctaUrl,
    visibility: reel.visibility,
    allowComments: reel.allowComments,
    allowDuets: reel.allowDuets,
    allowStitch: reel.allowStitch,
    allowDownload: reel.allowDownload,
    allowSharing: reel.allowSharing,
    muteOriginalAudio: reel.muteOriginalAudio,
    status: reel.status,
    viewsCount: reel.viewsCount || 0,
    likesCount: reel.likesCount || 0,
    commentsCount: reel.commentsCount || 0,
    sharesCount: reel.sharesCount || 0,
    savesCount: reel.savesCount || 0,
    isLiked,
    isSaved,
    publishedAt: reel.publishedAt,
    createdAt: reel.createdAt,
    updatedAt: reel.updatedAt,
  };
}

const reelInclude = (currentUserId?: string) => ({
  users: {
    select: {
      id: true,
      username: true,
      name: true,
      profileImage: true,
      headline: true,
      isVerified: true,
      profileBadgeStyle: true,
      ...(currentUserId
        ? {
            follows_follows_followingIdTousers: {
              where: { followerId: currentUserId },
              take: 1,
              select: { id: true },
            },
          }
        : {}),
    },
  },
  reel_audio: {
    select: {
      id: true,
      title: true,
      artist: true,
      albumArt: true,
    },
  },
  ...(currentUserId
    ? {
        reel_likes: { where: { userId: currentUserId }, select: { userId: true } },
        reel_saves: { where: { userId: currentUserId }, select: { userId: true } },
        reel_poll_votes: { where: { userId: currentUserId }, select: { optionId: true, userId: true } },
      }
    : {}),
});

function normalizeCacheQuery(query: Record<string, unknown>): string {
  return Object.entries(query)
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String).sort().join(',') : String(value ?? ''),
    ])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function anonymousReelsFeedCacheKey(query: Record<string, unknown>): string {
  return `reels:feed:public:${normalizeCacheQuery(query) || 'default'}`;
}

function invalidateReelsFeedCache(): void {
  cacheService.invalidateTags('reels:feed').catch(() => undefined);
}

function invalidateReelCacheTags(reel: { id: string; authorId: string }): void {
  cacheService
    .invalidateTags(
      'reels:feed',
      'feed:global',
      `reel:${reel.id}`,
      `reels:user:${reel.authorId}`,
      `feed:${reel.authorId}`
    )
    .catch((error: unknown) => {
      console.warn('Failed to invalidate reel cache tags:', error);
    });
}

function applyDateCursor(whereClause: any, cursorValue: unknown, scope: string, fieldName = 'createdAt'): void {
  const cursor = decodeKeysetCursor(cursorValue, scope);
  const cursorWhere = dateDescKeysetWhere(cursor, fieldName);
  if (!cursorWhere) return;
  whereClause.AND = [...(Array.isArray(whereClause.AND) ? whereClause.AND : []), cursorWhere];
}

function encodeDateCursor(scope: string, item: any, fieldName = 'createdAt'): string | null {
  const value = item?.[fieldName];
  if (!item?.id || !value) return null;
  return encodeKeysetCursor({
    scope,
    id: item.id,
    t: new Date(value).toISOString(),
  });
}

async function selectReelsAdPlacements(
  currentUserId: string | undefined,
  itemCount: number,
  itemOffset: number,
  sessionId?: string | null
) {
  try {
    return await selectManagedAdPlacements({
      userId: currentUserId,
      placement: 'reels',
      itemCount,
      itemOffset,
      sessionId,
    });
  } catch (error) {
    console.error('Failed to select reels ads:', error);
    return [];
  }
}

export const getReelsFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 10, 30);
    const mode = ensureString(req.query.mode) as 'foryou' | 'following' | undefined;
    const adSessionId = ensureString(req.query.adSessionId);
    const requestedAdItemOffset = parseInt(ensureString(req.query.adItemOffset) || '0', 10);
    const adItemOffset = Math.min(Math.max(Number.isFinite(requestedAdItemOffset) ? requestedAdItemOffset : 0, 0), 10000);

    let whereClause: any = {
      status: 'ready',
      visibility: 'public',
      publishedAt: { not: null },
    };

    const cacheKey = !currentUserId && mode !== 'following'
      ? anonymousReelsFeedCacheKey(req.query as Record<string, unknown>)
      : null;

    if (mode === 'following' && currentUserId) {
      const following = await prisma.follows.findMany({
        where: { followerId: currentUserId },
        select: { followingId: true },
      });
      const followingIds = following.map((f) => f.followingId);

      if (followingIds.length > 0) {
        whereClause.authorId = { in: followingIds };
      } else {
        res.json({ reels: [], nextCursor: null, hasMore: false, adPlacements: [] });
        return;
      }
    }

    const feedScope = mode === 'following' && currentUserId ? `reels.feed.following:${currentUserId}` : 'reels.feed';
    applyDateCursor(whereClause, cursor, feedScope, 'publishedAt');

    const computeResponse = async () => {
      const reels = await prisma.reels.findMany({
        where: whereClause,
        include: reelInclude(currentUserId),
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });

      const hasMore = reels.length > limit;
      const pageItems = hasMore ? reels.slice(0, limit) : reels;
      const rankedItems = mode === 'following' ? pageItems : rankForYouReels(pageItems);

      return {
        reels: rankedItems.map((reel) => mapReelResponse(reel, currentUserId)),
        nextCursor: hasMore ? encodeDateCursor(feedScope, pageItems[pageItems.length - 1], 'publishedAt') : null,
        hasMore,
        adPlacements: await selectReelsAdPlacements(currentUserId, rankedItems.length, adItemOffset, adSessionId),
      };
    };

    const response = cacheKey
      ? await cacheService.getOrSet(cacheKey, computeResponse, {
          tags: ['reels:feed'],
          swr: { softTtlSeconds: 10, hardTtlSeconds: 45 },
        })
      : await computeResponse();

    if (currentUserId && mode !== 'following') {
      const decorated = await decorateSurfaceRecommendations({
        userId: currentUserId,
        surface: 'REELS',
        entityType: 'REEL',
        items: response.reels,
        authorIdOf: (reel: any) => reel.authorId || reel.author?.id,
        createdAtOf: (reel: any) => reel.publishedAt || reel.createdAt,
        pageSize: response.reels.length || 1,
      });
      res.json({
        ...response,
        reels: decorated.items,
        recommendationSessionId: decorated.recommendationSessionId,
        requestId: decorated.requestId,
        rankerVersion: decorated.rankerVersion,
        experimentVariant: decorated.experimentVariant,
      });
      return;
    }
    res.json(response);
  } catch (error) {
    console.error('getReelsFeed error:', error);
    res.status(500).json({ error: 'Failed to fetch reels feed' });
  }
};

export const getFollowingFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    req.query.mode = 'following';
    return getReelsFeed(req, res);
  } catch (error) {
    console.error('getFollowingFeed error:', error);
    res.status(500).json({ error: 'Failed to fetch following feed' });
  }
};

export const getTrendingReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const hours = parseInt(ensureString(req.query.hours) || '24', 10);
    const limit = clampPageSize(req.query.limit, 20, 50);

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const trendingOrderBy = [
      { viewsCount: 'desc' },
      { likesCount: 'desc' },
      { commentsCount: 'desc' },
      { sharesCount: 'desc' },
      { publishedAt: 'desc' },
    ];
    const publicReadyWhere = {
      status: 'ready',
      visibility: 'public',
      publishedAt: { not: null },
    };

    let reels = await prisma.reels.findMany({
      where: {
        ...publicReadyWhere,
        publishedAt: { gte: since },
      },
      include: reelInclude(currentUserId),
      orderBy: trendingOrderBy,
      take: limit,
    });

    if (reels.length === 0) {
      reels = await prisma.reels.findMany({
        where: publicReadyWhere,
        include: reelInclude(currentUserId),
        orderBy: trendingOrderBy,
        take: limit,
      });
    }

    res.json({
      reels: reels.map((reel) => mapReelResponse(reel, currentUserId)),
      nextCursor: null,
      hasMore: false,
    });
  } catch (error) {
    console.error('getTrendingReels error:', error);
    res.status(500).json({ error: 'Failed to fetch trending reels' });
  }
};

export const getReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);

    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findFirst({
      where: {
        id: reelId,
        ...(await buildReelVisibilityWhere(currentUserId, { allowOwnerDraft: true })),
      },
      include: reelInclude(currentUserId),
    });

    if (!reel) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    res.json(mapReelResponse(reel, currentUserId));
  } catch (error) {
    console.error('getReel error:', error);
    res.status(500).json({ error: 'Failed to fetch reel' });
  }
};

export const getReelPreloadData = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const reelId = ensureString(req.params.reelId);

    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        visibility: true,
        hlsUrl: true,
        videoUrl: true,
        thumbnailUrl: true,
        durationSeconds: true,
        status: true,
        publishedAt: true,
      },
    });

    if (!reel || !(await canViewReel(reel, req.user?.userId))) {
      res.status(404).json({ error: 'Reel not found or not ready' });
      return;
    }

    res.json({
      hlsUrl: reel.hlsUrl,
      videoUrl: reel.videoUrl,
      thumbnailUrl: reel.thumbnailUrl,
      durationSeconds: reel.durationSeconds,
    });
  } catch (error) {
    console.error('getReelPreloadData error:', error);
    res.status(500).json({ error: 'Failed to fetch preload data' });
  }
};

/** Get reel's audio for "Use this audio" / Remix flow */
export const getReelAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        id: true,
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        audioId: true,
        reel_audio: {
          select: {
            id: true,
            title: true,
            artist: true,
            albumArt: true,
            audioUrl: true,
            durationMs: true,
            genre: true,
            originalReelId: true,
            usageCount: true,
          },
        },
        users: { select: { id: true, username: true, name: true } },
      },
    });

    if (!reel || !(await canViewReel(reel, req.user?.userId))) {
      res.status(404).json({ error: 'Reel not found or not ready' });
      return;
    }

    const reelWithAudio = reel as typeof reel & { reel_audio: { id: string; title: string; artist: string; albumArt: string | null; audioUrl: string | null; durationMs: number | null; genre: string | null; originalReelId: string | null; usageCount: number } | null; users: { id: string; username: string; name: string } };
    if (!reelWithAudio.reel_audio) {
      res.json({
        hasAudio: false,
        message: 'This reel uses original audio',
        audio: null,
      });
      return;
    }

    res.json({
      hasAudio: true,
      audio: {
        id: reelWithAudio.reel_audio.id,
        title: reelWithAudio.reel_audio.title,
        artist: reelWithAudio.reel_audio.artist,
        albumArt: reelWithAudio.reel_audio.albumArt,
        audioUrl: reelWithAudio.reel_audio.audioUrl,
        durationMs: reelWithAudio.reel_audio.durationMs,
        genre: reelWithAudio.reel_audio.genre,
        usageCount: reelWithAudio.reel_audio.usageCount,
        sourceReelId: reel.id,
        originalCreator: reelWithAudio.reel_audio.originalReelId ? reelWithAudio.users : null,
      },
    });
  } catch (error) {
    console.error('getReelAudio error:', error);
    res.status(500).json({ error: 'Failed to fetch reel audio' });
  }
};

export const getUploadUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const mimeType = ensureString(req.body?.mimeType);
    const sizeBytes = Number(req.body?.sizeBytes);
    const uploadKind = ensureString(req.body?.uploadKind) || 'video';

    if (!mimeType || !Number.isFinite(sizeBytes)) {
      res.status(400).json({ error: 'mimeType and sizeBytes are required' });
      return;
    }

    if (uploadKind === 'thumbnail') {
      const credential = createStorageUploadIntent({
        userId: req.user.userId,
        purpose: 'reel_thumbnail',
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
      return;
    }

    const title = `reel_${req.user.userId}_${Date.now()}`;
    const { videoId, uploadUrl } = await bunnyStreamService.createVideo(title);
    const credential = createBunnyStreamUploadIntent({
      userId: req.user.userId,
      videoId,
      mimeType,
      sizeBytes,
    });

    res.json({
      provider: 'bunny_stream',
      uploadMethod: 'TUS',
      videoId,
      uploadUrl: credential.uploadUrl,
      uploadHeaders: credential.headers,
      uploadToken: credential.token,
      expiresAt: credential.intent.expiresAt,
      maxBytes: credential.intent.maxBytes,
      mimeType,
      legacyUploadUrl: uploadUrl,
    });
  } catch (error) {
    console.error('getUploadUrl error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get upload URL';
    res.status(message.includes('large') || message.includes('Unsupported') ? 400 : 500).json({ error: message });
  }
};

function safeJsonParse<T>(val: string | undefined, fallback: T): T {
  if (!val) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

function boundedNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function reelForYouScore(reel: any): number {
  const publishedAt = reel.publishedAt ? new Date(reel.publishedAt).getTime() : Date.now();
  const ageHours = Math.max(0, (Date.now() - publishedAt) / (60 * 60 * 1000));
  const durationMs = Math.max(1000, boundedNumber(reel.durationSeconds, 0) * 1000);
  const averageWatchRatio = Math.min(1, boundedNumber(reel.avgWatchTimeMs, 0) / durationMs);
  const completionRate = Math.min(1, Math.max(0, boundedNumber(reel.completionRate, 0)));
  const engagement =
    Math.log1p(boundedNumber(reel.likesCount)) * 0.9 +
    Math.log1p(boundedNumber(reel.commentsCount)) * 1.35 +
    Math.log1p(boundedNumber(reel.savesCount)) * 1.6 +
    Math.log1p(boundedNumber(reel.sharesCount)) * 1.75;
  const quality = averageWatchRatio * 2.5 + completionRate * 3.5;
  const freshness = 4 / (1 + ageHours / 18);
  const newCreatorBoost =
    boundedNumber(reel.viewsCount) < 50 && ageHours < 24
      ? 1.2
      : 0;

  return freshness + quality + engagement + newCreatorBoost;
}

function rankForYouReels(reels: any[]): any[] {
  return [...reels].sort((a, b) => {
    const delta = reelForYouScore(b) - reelForYouScore(a);
    if (Math.abs(delta) > 0.0001) return delta;
    return new Date(b.publishedAt || b.createdAt).getTime() - new Date(a.publishedAt || a.createdAt).getTime();
  });
}

export const createReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const files = req.files as { video?: Express.Multer.File[]; thumbnail?: Express.Multer.File[] } | undefined;
    const file = (files?.video?.[0] || (req as any).file) as Express.Multer.File | undefined;

    if (!file) {
      res.status(400).json({ error: 'Video file is required' });
      return;
    }

    let videoId: string;
    let videoUrl: string;
    let hlsUrl: string | null;
    let thumbnailUrl: string;
    let previewGifUrl: string;

    const useBunnyStream = !!(
      process.env.BUNNY_STREAM_API_KEY &&
      process.env.BUNNY_STREAM_LIBRARY_ID &&
      process.env.BUNNY_STREAM_CDN_HOSTNAME
    );

    let usedBunnyStream = false;

    if (useBunnyStream) {
      try {
        const title = `reel_${userId}_${Date.now()}`;
        const created = await bunnyStreamService.createVideo(title);
        videoId = created.videoId;
        await bunnyStreamService.uploadVideo(videoId, file.buffer);
        videoUrl = bunnyStreamService.getMp4Url(videoId);
        hlsUrl = bunnyStreamService.getHlsUrl(videoId);
        thumbnailUrl = bunnyStreamService.getThumbnailUrl(videoId);
        previewGifUrl = bunnyStreamService.getPreviewUrl(videoId);
        usedBunnyStream = true;
      } catch (streamErr: any) {
        console.warn('Bunny Stream failed, falling back to Bunny Storage:', streamErr.message);
        videoId = `storage_${userId}_${Date.now()}`;
        videoUrl = await bunnyStorageService.uploadPostVideo(file.buffer, userId, file.mimetype);
        hlsUrl = null;
        thumbnailUrl = '';
        previewGifUrl = '';
      }
    } else {
      videoId = `storage_${userId}_${Date.now()}`;
      videoUrl = await bunnyStorageService.uploadPostVideo(file.buffer, userId, file.mimetype);
      hlsUrl = null;
      thumbnailUrl = '';
      previewGifUrl = '';
    }

    // Custom thumbnail (overrides Bunny Stream thumbnail when provided)
    const thumbnailFile = files?.thumbnail?.[0];
    if (thumbnailFile && thumbnailFile.mimetype.startsWith('image/')) {
      try {
        thumbnailUrl = await bunnyStorageService.uploadReelThumbnail(
          thumbnailFile.buffer,
          userId,
          thumbnailFile.mimetype
        );
      } catch (err) {
        console.warn('Failed to upload custom thumbnail:', err);
      }
    }

    const isDraft = req.body.saveAsDraft === 'true';
    const scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    const originalReelId = req.body.originalReelId || null;
    const responseType = req.body.responseType || null; // 'duet' | 'stitch'

    const reel = await prisma.reels.create({
      data: {
        id: randomUUID(),
        authorId: userId,
        videoId,
        videoUrl,
        hlsUrl,
        thumbnailUrl: thumbnailUrl || null,
        previewGifUrl: previewGifUrl || null,
        durationSeconds: 0,
        title: req.body.title || null,
        caption: req.body.caption || null,
        hashtags: safeJsonParse<string[]>(req.body.hashtags, []),
        mentions: safeJsonParse<string[]>(req.body.mentions, []),
        skills: safeJsonParse<string[]>(req.body.skills, []),
        topics: safeJsonParse<string[]>(req.body.topics, []),
        category: req.body.category || null,
        visibility: req.body.visibility || 'public',
        allowComments: req.body.allowComments !== 'false',
        allowDuets: req.body.allowDuets !== 'false',
        allowStitch: req.body.allowStitch !== 'false',
        allowDownload: req.body.allowDownload !== 'false',
        allowSharing: req.body.allowSharing !== 'false',
        codeSnippet: req.body.codeSnippet || null,
        codeLanguage: req.body.codeLanguage || null,
        codeFileName: req.body.codeFileName || null,
        repoUrl: req.body.repoUrl || null,
        status: isDraft ? 'draft' : usedBunnyStream ? 'processing' : 'ready',
        publishedAt: !isDraft && !usedBunnyStream ? new Date() : null,
        scheduledAt,
        originalReelId,
        isResponse: !!originalReelId,
        responseType,
        audioId: req.body.audioId || null,
        audioStartTime: parseInt(req.body.audioStartTime || '0', 10),
        muteOriginalAudio: req.body.muteOriginalAudio === 'true',
        updatedAt: new Date(),
      },
      include: reelInclude(userId),
    });

    recordActivity(userId, 'short_video', 1, { sourceId: reel.id }).catch(console.error);
    if (reel.status === 'ready' && reel.visibility === 'public') {
      invalidateReelsFeedCache();
    }

    res.status(201).json(mapReelResponse(reel, userId));
  } catch (error: any) {
    console.error('createReel error:', error);
    const message = error?.response?.data?.message || error?.message || 'Failed to create reel';
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      res.status(status).json({ error: message });
    } else if (error?.response?.data?.error) {
      res.status(status || 500).json({ error: error.response.data.error, message: error.response.data.message });
    } else {
      res.status(500).json({ error: 'Failed to create reel', message: process.env.NODE_ENV === 'development' ? message : undefined });
    }
  }
};

export const onUploadComplete = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const {
      videoId,
      title,
      caption,
      hashtags,
      visibility,
      uploadToken,
      mimeType,
      sizeBytes,
      thumbnail,
      ...metadata
    } = req.body;

    if (!videoId || !uploadToken || !mimeType || !Number.isFinite(Number(sizeBytes))) {
      res.status(400).json({ error: 'videoId, uploadToken, mimeType, and sizeBytes are required' });
      return;
    }

    validateFinalizedStreamMedia({
      userId,
      token: String(uploadToken),
      videoId: String(videoId),
      mimeType: String(mimeType),
      sizeBytes: Number(sizeBytes),
    });

    const videoInfo = await bunnyStreamService.getVideo(String(videoId)).catch(() => null);
    if (videoInfo?.storageSize && Number(videoInfo.storageSize) > Number(sizeBytes)) {
      res.status(400).json({ error: 'Uploaded video size does not match the issued credential' });
      return;
    }

    let thumbnailUrl = bunnyStreamService.getThumbnailUrl(videoId);
    if (thumbnail?.objectKey && thumbnail?.uploadToken && thumbnail?.mimeType && thumbnail?.sizeBytes) {
      try {
        thumbnailUrl = await validateFinalizedStorageMedia({
          userId,
          token: String(thumbnail.uploadToken),
          objectKey: String(thumbnail.objectKey),
          mimeType: String(thumbnail.mimeType),
          sizeBytes: Number(thumbnail.sizeBytes),
          purpose: 'reel_thumbnail',
        });
      } catch (thumbnailError) {
        res.status(400).json({
          error: thumbnailError instanceof Error ? thumbnailError.message : 'Invalid thumbnail upload',
        });
        return;
      }
    }

    const isDraft = metadata.saveAsDraft === true;
    const scheduledAt = metadata.scheduledAt ? new Date(metadata.scheduledAt as string) : null;
    const originalReelId = metadata.originalReelId as string | null || null;
    const responseType = metadata.responseType as string | null || null;

    const reel = await prisma.reels.create({
      data: {
        id: randomUUID(),
        authorId: userId,
        videoId,
        videoUrl: bunnyStreamService.getMp4Url(videoId),
        hlsUrl: bunnyStreamService.getHlsUrl(videoId),
        thumbnailUrl,
        previewGifUrl: bunnyStreamService.getPreviewUrl(videoId),
        durationSeconds: metadata.durationSeconds || 0,
        width: metadata.width || videoInfo?.width || 1080,
        height: metadata.height || videoInfo?.height || 1920,
        fileSize: Number(sizeBytes),
        title: title || null,
        caption: caption || null,
        hashtags: hashtags || [],
        visibility: visibility || 'public',
        status: isDraft ? 'draft' : 'processing',
        scheduledAt,
        originalReelId,
        isResponse: !!originalReelId,
        responseType,
        audioId: metadata.audioId as string | null || null,
        audioStartTime: parseInt(String(metadata.audioStartTime || 0), 10),
        muteOriginalAudio: metadata.muteOriginalAudio === true,
        ...metadata,
        updatedAt: new Date(),
      },
      include: reelInclude(userId),
    });

    recordActivity(userId, 'short_video', 1, { sourceId: reel.id }).catch(console.error);
    if (reel.status === 'ready' && reel.visibility === 'public') {
      invalidateReelsFeedCache();
    }

    res.status(201).json(mapReelResponse(reel, userId));
  } catch (error) {
    console.error('onUploadComplete error:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
};

export const updateReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const existing = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only edit your own reels' });
      return;
    }

    const updateData: any = {};
    const allowedFields = [
      'title',
      'caption',
      'hashtags',
      'mentions',
      'skills',
      'topics',
      'category',
      'visibility',
      'allowComments',
      'allowDuets',
      'allowStitch',
      'allowDownload',
      'allowSharing',
      'scheduledAt',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
        if (field === 'scheduledAt' && req.body[field]) {
          updateData[field] = new Date(req.body[field]);
        }
      }
    }

    const reel = await prisma.reels.update({
      where: { id: reelId },
      data: updateData,
      include: reelInclude(userId),
    });

    invalidateReelsFeedCache();
    res.json(mapReelResponse(reel, userId));
  } catch (error) {
    console.error('updateReel error:', error);
    res.status(500).json({ error: 'Failed to update reel' });
  }
};

export const publishDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { scheduledAt } = req.body;

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, status: true },
    });

    if (!reel) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (reel.authorId !== userId) {
      res.status(403).json({ error: 'You can only publish your own reels' });
      return;
    }

    if (reel.status !== 'draft') {
      res.status(400).json({ error: 'Only drafts can be published' });
      return;
    }

    const publishAt = scheduledAt ? new Date(scheduledAt) : new Date();
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    await prisma.reels.update({
      where: { id: reelId },
      data: {
        status: 'ready',
        visibility: 'public',
        scheduledAt: isScheduled ? publishAt : null,
        publishedAt: isScheduled ? null : publishAt,
      },
    });

    invalidateReelsFeedCache();
    const updated = await prisma.reels.findUnique({
      where: { id: reelId },
      include: reelInclude(userId),
    });

    res.json(mapReelResponse(updated!, userId));
  } catch (error) {
    console.error('publishDraft error:', error);
    res.status(500).json({ error: 'Failed to publish draft' });
  }
};

export const deleteReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const existing = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true, videoId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own reels' });
      return;
    }

    await prisma.reels.delete({ where: { id: reelId } });
    invalidateReelsFeedCache();
    bunnyStreamService.deleteVideo(existing.videoId).catch(console.error);

    res.json({ success: true });
  } catch (error) {
    console.error('deleteReel error:', error);
    res.status(500).json({ error: 'Failed to delete reel' });
  }
};

export const toggleLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const [reel, user] = await Promise.all([
      prisma.reels.findUnique({
        where: { id: reelId },
        select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true },
      }),
    ]);

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const existingLike = await prisma.reel_likes.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    let liked = false;
    let likesCount = reel.likesCount || 0;
    if (existingLike) {
      const result = await prisma.$transaction(async (tx) => {
        const deleted = await tx.reel_likes.deleteMany({
          where: { reelId, userId },
        });
        if (deleted.count !== 1) {
          const current = await tx.reels.findUnique({
            where: { id: reelId },
            select: { likesCount: true },
          });
          return { liked: false, likesCount: current?.likesCount || 0 };
        }

        const updatedReel = await tx.reels.update({
          where: { id: reelId },
          data: { likesCount: { decrement: 1 } },
          select: { likesCount: true },
        });
        return { liked: false, likesCount: updatedReel.likesCount };
      });
      liked = result.liked;
      likesCount = result.likesCount;
    } else {
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.reel_likes.create({
            data: { reelId, userId },
          });
          const updatedReel = await tx.reels.update({
            where: { id: reelId },
            data: { likesCount: { increment: 1 } },
            select: { likesCount: true },
          });
          return { liked: true, likesCount: updatedReel.likesCount };
        });
        liked = result.liked;
        likesCount = result.likesCount;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        liked = true;
        const current = await prisma.reels.findUnique({
          where: { id: reelId },
          select: { likesCount: true },
        });
        likesCount = current?.likesCount || 0;
      }
    }

    const io = getIO();
    if (io) {
      // Broadcast to reel room for real-time updates
      io.to(`reel:${reelId}`).emit('reel:engagement_update', { 
        reelId, 
        type: 'like',
        userId, 
        liked, 
        likesCount 
      });
    }

    // Send notification for likes (persisted)
    if (liked && reel.authorId !== userId && user) {
      notificationService.notifyReelLike(
        reel.authorId,
        userId,
        user.name || user.username,
        reelId
      );
    }

    if (liked) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'REACTION', meaningfulOutcome: false,
    }).catch(() => undefined);

    res.json({ liked, likesCount });
  } catch (error) {
    console.error('toggleLike error:', error);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
};

export const toggleSave = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const existingSave = await prisma.reel_saves.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    let saved = false;
    if (existingSave) {
      await prisma.reel_saves.delete({
        where: { reelId_userId: { reelId, userId } },
      });
    } else {
      await prisma.reel_saves.create({
        data: { reelId, userId },
      });
      saved = true;
    }

    const savesCount = await prisma.reel_saves.count({ where: { reelId } });
    await prisma.reels.update({
      where: { id: reelId },
      data: { savesCount },
    });

    if (saved) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'SAVE', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.json({ saved, savesCount });
  } catch (error) {
    console.error('toggleSave error:', error);
    res.status(500).json({ error: 'Failed to toggle save' });
  }
};

export const shareReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { shareType, platform, recipientId } = req.body;

    const [reel, user] = await Promise.all([
      prisma.reels.findUnique({
        where: { id: reelId },
        select: { 
          id: true, 
          authorId: true,
          visibility: true,
          status: true,
          publishedAt: true,
          allowSharing: true, 
          sharesCount: true,
          title: true,
          caption: true,
          thumbnailUrl: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true },
      }),
    ]);

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (!reel.allowSharing) {
      res.status(403).json({ error: 'Sharing is disabled for this reel' });
      return;
    }

    let createdShare = false;
    let sharesCount = reel.sharesCount || 0;
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.reel_shares.create({
          data: {
            reelId,
            userId,
            shareType: shareType || 'copy_link',
            platform,
            recipientId,
          },
        });

        const updatedReel = await tx.reels.update({
          where: { id: reelId },
          data: { sharesCount: { increment: 1 } },
          select: { sharesCount: true },
        });

        return { createdShare: true, sharesCount: updatedReel.sharesCount };
      });
      createdShare = result.createdShare;
      sharesCount = result.sharesCount;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const current = await prisma.reels.findUnique({
        where: { id: reelId },
        select: { sharesCount: true },
      });
      sharesCount = current?.sharesCount || 0;
    }

    const io = getIO();
    if (io) {
      io.to(`reel:${reelId}`).emit('reel:engagement_update', { 
        reelId, 
        type: 'share',
        sharesCount 
      });
    }

    // Notify reel author about the share
    if (createdShare && reel.authorId !== userId && user) {
      notificationService.notifyReelShare(
        reel.authorId,
        userId,
        user.name || user.username,
        reelId
      );
    }

    if (createdShare) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'SHARE', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.json({ success: true, sharesCount });
  } catch (error) {
    console.error('shareReel error:', error);
    res.status(500).json({ error: 'Failed to share reel' });
  }
};

// Share reel in chat (send to specific user)
export const shareReelInChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { recipientId, message } = req.body;

    if (!recipientId) {
      res.status(400).json({ error: 'recipientId is required' });
      return;
    }

    const [reel, sender, recipient] = await Promise.all([
      prisma.reels.findUnique({
        where: { id: reelId },
        select: {
          id: true,
          authorId: true,
          visibility: true,
          status: true,
          publishedAt: true,
          title: true,
          caption: true,
          thumbnailUrl: true,
          hlsUrl: true,
          videoUrl: true,
          allowSharing: true,
          sharesCount: true,
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
        },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, username: true, profileImage: true, isVerified: true },
      }),
      prisma.user.findUnique({
        where: { id: recipientId },
        select: { id: true, name: true, username: true },
      }),
    ]);

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (!reel.allowSharing) {
      res.status(403).json({ error: 'Sharing is disabled for this reel' });
      return;
    }

    if (!recipient) {
      res.status(404).json({ error: 'Recipient not found' });
      return;
    }

    if (!(await canViewReel(reel, recipientId))) {
      res.status(403).json({ error: 'Recipient cannot access this reel' });
      return;
    }

    // Get or create conversation
    let conversation = await prisma.conversations.findFirst({
      where: {
        OR: [
          { participant1Id: userId, participant2Id: recipientId },
          { participant1Id: recipientId, participant2Id: userId },
        ],
      },
    });

    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          participant1Id: userId,
          participant2Id: recipientId,
        },
      });
    }

    // Create message with reel content
    const reelData = {
      reelId: reel.id,
      title: reel.title,
      caption: reel.caption,
      thumbnailUrl: reel.thumbnailUrl,
      author: reel.users,
    };

    const chatMessage = await prisma.messages.create({
      data: {
        conversationId: conversation.id,
        senderId: userId,
        receiverId: recipientId,
        content: JSON.stringify({ reelId: reel.id }),
        contentType: 'reel',
        mediaUrl: reel.thumbnailUrl,
        mediaType: 'reel',
      },
    });

    // Update conversation lastMessageAt
    await prisma.conversations.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    // Record share
    await prisma.reel_shares.create({
      data: {
        reelId,
        userId,
        shareType: 'chat',
        recipientId,
      },
    });

    // Update share count
    const sharesCount = reel.sharesCount + 1;
    await prisma.reels.update({
      where: { id: reelId },
      data: { sharesCount },
    });

    // Send real-time message to recipient
    const io = getIO();
    if (io) {
      const messagePayload = {
        id: chatMessage.id,
        conversationId: conversation.id,
        senderId: userId,
        receiverId: recipientId,
        content: chatMessage.content,
        contentType: 'reel',
        mediaUrl: chatMessage.mediaUrl,
        mediaType: 'reel',
        reelData: { ...reel, reelId: reel.id },
        status: 'SENT',
        createdAt: chatMessage.createdAt.toISOString(),
        sender,
      };

      // Send to conversation room (match format expected by frontend: { conversationId, message })
      io.to(`chat:${conversation.id}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });

      // Send notification to recipient
      io.to(`user:${recipientId}`).emit('chat:notification', {
        conversationId: conversation.id,
        message: messagePayload,
      });

      // Update reel engagement
      io.to(`reel:${reelId}`).emit('reel:engagement_update', {
        reelId,
        type: 'share',
        sharesCount,
      });
    }

    // Notify reel author about the share
    if (reel.authorId !== userId && sender) {
      notificationService.notifyReelShare(
        reel.authorId,
        userId,
        sender.name || sender.username,
        reelId
      );
    }

    res.json({
      success: true,
      message: {
        id: chatMessage.id,
        conversationId: conversation.id,
        reelData,
      },
      sharesCount,
    });
  } catch (error) {
    console.error('shareReelInChat error:', error);
    res.status(500).json({ error: 'Failed to share reel in chat' });
  }
};

const VIEW_BATCH_MAX_ITEMS = Number(process.env.REELS_VIEW_BATCH_MAX_ITEMS || 500);
let viewBatch: Map<string, { reelId: string; userId?: string; watchTimeMs: number; completed: boolean; source?: string }[]> = new Map();
let viewBatchTimeout: NodeJS.Timeout | null = null;
let viewBatchItemCount = 0;

async function flushViewBatch() {
  const batch = viewBatch;
  viewBatch = new Map();
  viewBatchItemCount = 0;

  for (const [reelId, views] of batch) {
    try {
      const uniqueViews = new Map<string, typeof views[0]>();
      for (const view of views) {
        const key = view.userId || `anon_${Math.random()}`;
        const existing = uniqueViews.get(key);
        if (!existing || view.watchTimeMs > existing.watchTimeMs) {
          uniqueViews.set(key, view);
        }
      }

      for (const view of uniqueViews.values()) {
        if (view.userId) {
          const existingView = await prisma.reel_views.findFirst({
            where: { reelId, userId: view.userId },
          });

          if (existingView) {
            await prisma.reel_views.update({
              where: { id: existingView.id },
              data: {
                watchTimeMs: Math.max(existingView.watchTimeMs, view.watchTimeMs),
                completedWatch: existingView.completedWatch || view.completed,
                replayCount: view.completed && existingView.completedWatch
                  ? existingView.replayCount + 1
                  : existingView.replayCount,
              },
            });
          } else {
            await prisma.reel_views.create({
              data: {
                reelId,
                userId: view.userId,
                watchTimeMs: view.watchTimeMs,
                completedWatch: view.completed,
                source: view.source,
              },
            });
          }
        } else {
          await prisma.reel_views.create({
            data: {
              reelId,
              watchTimeMs: view.watchTimeMs,
              completedWatch: view.completed,
              source: view.source,
            },
          });
        }
      }

      const [totalViews, uniqueViewsCount] = await Promise.all([
        prisma.reel_views.count({ where: { reelId } }),
        prisma.reel_views.groupBy({
          by: ['userId'],
          where: { reelId, userId: { not: null } },
        }),
      ]);

      const avgWatchTime = await prisma.reel_views.aggregate({
        where: { reelId },
        _avg: { watchTimeMs: true },
      });

      const completedViews = await prisma.reel_views.count({
        where: { reelId, completedWatch: true },
      });

      await prisma.reels.update({
        where: { id: reelId },
        data: {
          viewsCount: totalViews,
          uniqueViewsCount: uniqueViewsCount.length,
          avgWatchTimeMs: Math.round(avgWatchTime._avg.watchTimeMs || 0),
          completionRate: totalViews > 0 ? completedViews / totalViews : 0,
        },
      });
    } catch (error) {
      console.error(`Error flushing view batch for reel ${reelId}:`, error);
    }
  }
}

export const trackView = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { watchTimeMs, completed, source } = req.body;

    if (watchTimeMs < 3000) {
      res.json({ success: true });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true, visibility: true, status: true, publishedAt: true },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const reelViews = viewBatch.get(reelId) || [];
    reelViews.push({
      reelId,
      userId,
      watchTimeMs: watchTimeMs || 0,
      completed: completed || false,
      source,
    });
    viewBatch.set(reelId, reelViews);
    viewBatchItemCount += 1;

    if (viewBatchItemCount >= VIEW_BATCH_MAX_ITEMS) {
      if (viewBatchTimeout) {
        clearTimeout(viewBatchTimeout);
        viewBatchTimeout = null;
      }
      setImmediate(() => flushViewBatch().catch(console.error));
    } else if (!viewBatchTimeout) {
      viewBatchTimeout = setTimeout(() => {
        viewBatchTimeout = null;
        flushViewBatch().catch(console.error);
      }, 5000);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('trackView error:', error);
    res.status(500).json({ error: 'Failed to track view' });
  }
};

export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const parentId = ensureString(req.query.parentId) || undefined;
    const cursor = ensureString(req.query.cursor);
    const highlightCommentId = ensureString(req.query.highlightCommentId) || ensureString(req.query.commentId);
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        id: true,
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        allowComments: true,
      },
    });

    if (!reel || !(await canViewReel(reel, currentUserId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const where: any = { reelId, parentId: parentId || null };
    const commentInclude = {
      users: { select: reelCommentAuthorSelect },
      ...(currentUserId
        ? {
            reel_comment_likes: {
              where: { userId: currentUserId },
              select: { userId: true },
            },
          }
        : {}),
      _count: { select: { other_reel_comments: true } },
    };

    const comments = await prisma.reel_comments.findMany({
      where,
      include: commentInclude,
      orderBy: [{ isPinned: 'desc' }, { likesCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = comments.length > limit;
    let items = hasMore ? comments.slice(0, limit) : comments;

    if (highlightCommentId) {
      const focus = await prisma.reel_comments.findFirst({
        where: { id: highlightCommentId, reelId },
        select: { id: true, parentId: true },
      });
      const focusListId = parentId ? focus?.id : (focus?.parentId || focus?.id);
      const belongsInList = parentId
        ? focus?.parentId === parentId
        : focus && !parentId;

      if (focusListId && belongsInList) {
        const focusedComment = await prisma.reel_comments.findFirst({
          where: {
            id: focusListId,
            reelId,
            parentId: parentId || null,
          },
          include: commentInclude,
        });

        if (focusedComment) {
          items = [
            focusedComment,
            ...items.filter((comment) => comment.id !== focusedComment.id),
          ].slice(0, limit);
        }
      }
    }

    res.json({
      comments: items.map((comment) => mapReelComment(comment, currentUserId)),
      nextCursor: hasMore ? items[items.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    console.error('getComments error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
};

export const createComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { content, parentId, mentions } = req.body;

    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        id: true,
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        allowComments: true,
      },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (!reel.allowComments) {
      res.status(403).json({ error: 'Comments are disabled for this reel' });
      return;
    }

    if (parentId) {
      const parentComment = await prisma.reel_comments.findFirst({
        where: { id: String(parentId), reelId },
        select: { id: true },
      });
      if (!parentComment) {
        res.status(400).json({ error: 'Parent comment is invalid for this reel' });
        return;
      }
    }

    const normalizedMentions = normalizeMentionUsernames(content, mentions);

    const { comment, commentsCount } = await prisma.$transaction(async (tx) => {
      const createdComment = await tx.reel_comments.create({
        data: {
          reelId,
          authorId: userId,
          content: content.trim(),
          parentId: parentId || null,
          mentions: normalizedMentions,
        },
        include: {
          users: { select: reelCommentAuthorSelect },
          reel_comments: parentId ? {
            select: {
              authorId: true,
              users: {
                select: { name: true, username: true },
              },
            },
          } : false,
        },
      });

      if (parentId) {
        await tx.reel_comments.update({
          where: { id: parentId },
          data: { repliesCount: { increment: 1 } },
        });
        const current = await tx.reels.findUnique({
          where: { id: reelId },
          select: { commentsCount: true },
        });
        return { comment: createdComment, commentsCount: current?.commentsCount || 0 };
      }

      const updatedReel = await tx.reels.update({
        where: { id: reelId },
        data: { commentsCount: { increment: 1 } },
        select: { commentsCount: true },
      });
      return { comment: createdComment, commentsCount: updatedReel.commentsCount };
    });

    const commentAuthor = mapReelCommentAuthor(comment.users);
    const parentComment = comment.reel_comments as
      | { authorId: string; users: { name: string | null; username: string } | null }
      | null;

    const io = getIO();
    if (io) {
      // Broadcast to reel room for real-time updates
      io.to(`reel:${reelId}`).emit('reel:engagement_update', {
        reelId,
        type: 'comment',
        comment: {
          id: comment.id,
          author: commentAuthor,
          content: comment.content,
          parentId: comment.parentId,
        },
        commentsCount,
      });
    }

    // Send notification to reel author (if not commenting on own reel)
    if (reel.authorId !== userId) {
      notificationService.notifyReelComment(
        reel.authorId,
        userId,
        commentAuthor.name || commentAuthor.username,
        reelId,
        comment.id,
        comment.content
      );
    }

    // Send notification to parent comment author (if replying)
    if (parentId && parentComment && parentComment.authorId !== userId) {
      notificationService.notifyReelCommentReply(
        parentComment.authorId,
        userId,
        commentAuthor.name || commentAuthor.username,
        reelId,
        comment.id,
        parentId,
        comment.content
      );
    }

    // Send notifications for @mentions
    if (normalizedMentions.length > 0) {
      const mentionedUsers = await prisma.user.findMany({
        where: {
          isBanned: false,
          OR: normalizedMentions.map((username) => ({
            username: { equals: username, mode: 'insensitive' },
          })),
        },
        select: { id: true, username: true },
      });

      for (const mentionedUser of mentionedUsers) {
        if (mentionedUser.id !== userId) {
          notificationService.notifyMention(
            mentionedUser.id,
            userId,
            commentAuthor.name || commentAuthor.username,
            'reel_comment',
            reelId,
            comment.content,
            {
              commentId: comment.id,
              parentCommentId: comment.parentId || undefined,
            }
          );
        }
      }
    }

    res.status(201).json({
      id: comment.id,
      reelId: comment.reelId,
      parentId: comment.parentId,
      author: commentAuthor,
      content: comment.content,
      mentions: comment.mentions,
      likesCount: 0,
      repliesCount: 0,
      isLiked: false,
      isPinned: false,
      isAuthorHeart: false,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });
  } catch (error) {
    console.error('createComment error:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
};

export const toggleCommentLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const commentId = ensureString(req.params.commentId);
    if (!commentId) {
      res.status(400).json({ error: 'Comment ID is required' });
      return;
    }

    const existing = await prisma.reel_comment_likes.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });

    const comment = await prisma.reel_comments.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        reelId: true,
        reels: {
          select: { authorId: true, visibility: true, status: true, publishedAt: true },
        },
      },
    });

    if (!comment || comment.reelId !== ensureString(req.params.reelId) || !(await canViewReel(comment.reels, userId))) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    let liked = false;
    if (existing) {
      await prisma.reel_comment_likes.delete({
        where: { commentId_userId: { commentId, userId } },
      });
    } else {
      await prisma.reel_comment_likes.create({
        data: { commentId, userId },
      });
      liked = true;
    }

    const likesCount = await prisma.reel_comment_likes.count({ where: { commentId } });
    await prisma.reel_comments.update({
      where: { id: commentId },
      data: { likesCount },
    });

    res.json({ liked, likesCount });
  } catch (error) {
    console.error('toggleCommentLike error:', error);
    res.status(500).json({ error: 'Failed to toggle comment like' });
  }
};

export const deleteComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    const commentId = ensureString(req.params.commentId);
    if (!reelId || !commentId) {
      res.status(400).json({ error: 'Reel ID and Comment ID are required' });
      return;
    }

    const comment = await prisma.reel_comments.findUnique({
      where: { id: commentId },
      select: { authorId: true, reelId: true, parentId: true },
    });

    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true },
    });

    if (!reel || comment.reelId !== reelId) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    if (comment.authorId !== userId && reel.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own comments' });
      return;
    }

    await prisma.reel_comments.delete({ where: { id: commentId } });

    if (comment.parentId) {
      await prisma.reel_comments.update({
        where: { id: comment.parentId },
        data: { repliesCount: { decrement: 1 } },
      });
    }

    const commentsCount = await prisma.reel_comments.count({
      where: { reelId, parentId: null },
    });
    await prisma.reels.update({
      where: { id: reelId },
      data: { commentsCount },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('deleteComment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

export const heartComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    const commentId = ensureString(req.params.commentId);
    if (!reelId || !commentId) {
      res.status(400).json({ error: 'Reel ID and Comment ID are required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true },
    });

    if (!reel || reel.authorId !== userId) {
      res.status(403).json({ error: 'Only the reel author can heart comments' });
      return;
    }

    const comment = await prisma.reel_comments.findUnique({
      where: { id: commentId },
      select: { isAuthorHeart: true, reelId: true },
    });

    if (!comment || comment.reelId !== reelId) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    await prisma.reel_comments.update({
      where: { id: commentId },
      data: { isAuthorHeart: !comment.isAuthorHeart },
    });

    res.json({ isAuthorHeart: !comment.isAuthorHeart });
  } catch (error) {
    console.error('heartComment error:', error);
    res.status(500).json({ error: 'Failed to heart comment' });
  }
};

export const votePoll = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { optionId } = req.body;

    if (optionId === undefined) {
      res.status(400).json({ error: 'Option ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        pollQuestion: true,
        pollOptions: true,
        pollEndsAt: true,
      },
    });

    if (!reel || !(await canViewReel(reel, userId)) || !reel.pollQuestion) {
      res.status(404).json({ error: 'Poll not found' });
      return;
    }

    if (reel.pollEndsAt && new Date(reel.pollEndsAt) < new Date()) {
      res.status(400).json({ error: 'Poll has ended' });
      return;
    }

    const existingVote = await prisma.reel_poll_votes.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    if (existingVote) {
      res.status(400).json({ error: 'You have already voted' });
      return;
    }

    await prisma.reel_poll_votes.create({
      data: { reelId, userId, optionId },
    });

    const pollOptions = (reel.pollOptions as any[]) || [];
    const updatedOptions = pollOptions.map((opt: any) => ({
      ...opt,
      votes: opt.id === optionId ? (opt.votes || 0) + 1 : opt.votes || 0,
    }));

    await prisma.reels.update({
      where: { id: reelId },
      data: { pollOptions: updatedOptions },
    });

    res.json({ success: true, pollOptions: updatedOptions, userVotedOption: optionId });
  } catch (error) {
    console.error('votePoll error:', error);
    res.status(500).json({ error: 'Failed to vote on poll' });
  }
};

export const answerQuiz = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { optionId } = req.body;

    if (optionId === undefined) {
      res.status(400).json({ error: 'Option ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        quizQuestion: true,
        quizCorrectIndex: true,
      },
    });

    if (!reel || !(await canViewReel(reel, userId)) || !reel.quizQuestion) {
      res.status(404).json({ error: 'Quiz not found' });
      return;
    }

    const existingAnswer = await prisma.reel_quiz_answers.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    if (existingAnswer) {
      res.status(400).json({ error: 'You have already answered' });
      return;
    }

    const isCorrect = optionId === reel.quizCorrectIndex;

    await prisma.reel_quiz_answers.create({
      data: { reelId, userId, optionId, isCorrect },
    });

    res.json({ correct: isCorrect, correctAnswer: reel.quizCorrectIndex });
  } catch (error) {
    console.error('answerQuiz error:', error);
    res.status(500).json({ error: 'Failed to answer quiz' });
  }
};

export const getReelsByHashtag = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const hashtag = ensureString(req.params.hashtag);
    const cursor = ensureString(req.query.cursor);
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);

    const whereClause: any = {
        status: 'ready',
        visibility: 'public',
        hashtags: { has: hashtag },
    };
    const scope = `reels.hashtag:${hashtag}`;
    applyDateCursor(whereClause, cursor, scope);
    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = reels.length > limit;
    const pageItems = hasMore ? reels.slice(0, limit) : reels;

    res.json({
      hashtag,
      reels: pageItems.map((reel) => mapReelResponse(reel, currentUserId)),
      nextCursor: hasMore ? encodeDateCursor(scope, pageItems[pageItems.length - 1]) : null,
      hasMore,
    });
  } catch (error) {
    console.error('getReelsByHashtag error:', error);
    res.status(500).json({ error: 'Failed to fetch reels by hashtag' });
  }
};

export const getReelsByAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const audioId = ensureString(req.params.audioId);
    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);

    const whereClause: any = {
        status: 'ready',
        visibility: 'public',
        audioId,
    };
    const scope = `reels.audio:${audioId}`;
    applyDateCursor(whereClause, cursor, scope);
    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = reels.length > limit;
    const pageItems = hasMore ? reels.slice(0, limit) : reels;

    res.json({
      audioId,
      reels: pageItems.map((reel) => mapReelResponse(reel, currentUserId)),
      nextCursor: hasMore ? encodeDateCursor(scope, pageItems[pageItems.length - 1]) : null,
      hasMore,
    });
  } catch (error) {
    console.error('getReelsByAudio error:', error);
    res.status(500).json({ error: 'Failed to fetch reels by audio' });
  }
};

export const getUserReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const userId = ensureString(req.params.userId);
    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);

    const whereClause: any = {
      authorId: userId,
      status: 'ready',
    };

    if (currentUserId !== userId) {
      whereClause.visibility = 'public';
    }
    const scope = `reels.user:${userId}:${currentUserId === userId ? 'self' : 'public'}`;
    applyDateCursor(whereClause, cursor, scope);

    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = reels.length > limit;
    const pageItems = hasMore ? reels.slice(0, limit) : reels;

    res.json({
      reels: pageItems.map((reel) => mapReelResponse(reel, currentUserId)),
      nextCursor: hasMore ? encodeDateCursor(scope, pageItems[pageItems.length - 1]) : null,
      hasMore,
    });
  } catch (error) {
    console.error('getUserReels error:', error);
    res.status(500).json({ error: 'Failed to fetch user reels' });
  }
};

export const getUserLikedReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = req.user.userId;
    const userId = ensureString(req.params.userId);

    if (currentUserId !== userId) {
      res.status(403).json({ error: 'You can only view your own liked reels' });
      return;
    }

    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);
    const scope = `reels.liked:${userId}`;
    const cursorWhere = dateDescKeysetWhere(decodeKeysetCursor(cursor, scope), 'createdAt');

    const likes = await prisma.reel_likes.findMany({
      where: {
        userId,
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      include: {
        reels: {
          include: reelInclude(currentUserId),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = likes.length > limit;
    const pageItems = hasMore ? likes.slice(0, limit) : likes;
    const visibleItems = [];
    for (const like of pageItems) {
      if (like.reels.status === 'ready' && await canViewReel(like.reels, currentUserId)) {
        visibleItems.push(like);
      }
    }

    res.json({
      reels: visibleItems
        .map((l) => mapReelResponse(l.reels, currentUserId)),
      nextCursor: hasMore ? encodeDateCursor(scope, pageItems[pageItems.length - 1]) : null,
      hasMore,
    });
  } catch (error) {
    console.error('getUserLikedReels error:', error);
    res.status(500).json({ error: 'Failed to fetch liked reels' });
  }
};

export const getUserSavedReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = req.user.userId;
    const userId = ensureString(req.params.userId);

    if (currentUserId !== userId) {
      res.status(403).json({ error: 'You can only view your own saved reels' });
      return;
    }

    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);
    const scope = `reels.saved:${userId}`;
    const cursorWhere = dateDescKeysetWhere(decodeKeysetCursor(cursor, scope), 'createdAt');

    const saves = await prisma.reel_saves.findMany({
      where: {
        userId,
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      include: {
        reels: {
          include: reelInclude(currentUserId),
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = saves.length > limit;
    const pageItems = hasMore ? saves.slice(0, limit) : saves;
    const visibleItems = [];
    for (const save of pageItems) {
      if (save.reels.status === 'ready' && await canViewReel(save.reels, currentUserId)) {
        visibleItems.push(save);
      }
    }

    res.json({
      reels: visibleItems
        .map((s) => mapReelResponse(s.reels, currentUserId)),
      nextCursor: hasMore ? encodeDateCursor(scope, pageItems[pageItems.length - 1]) : null,
      hasMore,
    });
  } catch (error) {
    console.error('getUserSavedReels error:', error);
    res.status(500).json({ error: 'Failed to fetch saved reels' });
  }
};

export const getDrafts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);
    const scope = `reels.drafts:${userId}`;
    const cursorWhere = dateDescKeysetWhere(decodeKeysetCursor(cursor, scope), 'updatedAt');

    const drafts = await prisma.reels.findMany({
      where: {
        authorId: userId,
        status: 'draft',
        ...(cursorWhere ? { AND: [cursorWhere] } : {}),
      },
      include: reelInclude(userId),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = drafts.length > limit;
    const results = hasMore ? drafts.slice(0, -1) : drafts;

    res.json({
      reels: results.map((r) => mapReelResponse(r, userId)),
      nextCursor: hasMore ? encodeDateCursor(scope, results[results.length - 1], 'updatedAt') : null,
      hasMore,
    });
  } catch (error) {
    console.error('getDrafts error:', error);
    res.status(500).json({ error: 'Failed to fetch drafts' });
  }
};

export const getReelResponses = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);
    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);

    const original = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true, visibility: true, status: true, publishedAt: true },
    });
    if (!original || !(await canViewReel(original, currentUserId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const scope = `reels.responses:${reelId}`;
    const whereClause: any = {
        originalReelId: reelId,
        status: 'ready',
        visibility: 'public',
    };
    applyDateCursor(whereClause, cursor, scope);
    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = reels.length > limit;
    const pageItems = hasMore ? reels.slice(0, limit) : reels;

    res.json({
      reels: pageItems.map((reel) => mapReelResponse(reel, currentUserId)),
      nextCursor: hasMore ? encodeDateCursor(scope, pageItems[pageItems.length - 1]) : null,
      hasMore,
    });
  } catch (error) {
    console.error('getReelResponses error:', error);
    res.status(500).json({ error: 'Failed to fetch reel responses' });
  }
};

export const getCreatorAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const days = parseInt(ensureString(req.query.days) || '30', 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [reels, totalStats] = await Promise.all([
      prisma.reels.findMany({
        where: { authorId: userId, status: 'ready' },
        select: {
          id: true,
          viewsCount: true,
          likesCount: true,
          commentsCount: true,
          sharesCount: true,
          savesCount: true,
          avgWatchTimeMs: true,
          completionRate: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.reels.aggregate({
        where: { authorId: userId, status: 'ready' },
        _sum: {
          viewsCount: true,
          likesCount: true,
          commentsCount: true,
          sharesCount: true,
          savesCount: true,
        },
        _avg: {
          avgWatchTimeMs: true,
          completionRate: true,
        },
        _count: true,
      }),
    ]);

    const recentViews = await prisma.reel_views.count({
      where: {
        reels: { authorId: userId },
        createdAt: { gte: since },
      },
    });

    const topReels = reels
      .slice(0, 10)
      .sort((a, b) => (b.viewsCount || 0) - (a.viewsCount || 0));

    res.json({
      totalReels: totalStats._count,
      totalViews: totalStats._sum.viewsCount || 0,
      totalLikes: totalStats._sum.likesCount || 0,
      totalComments: totalStats._sum.commentsCount || 0,
      totalShares: totalStats._sum.sharesCount || 0,
      totalSaves: totalStats._sum.savesCount || 0,
      avgWatchTimeMs: Math.round(totalStats._avg.avgWatchTimeMs || 0),
      avgCompletionRate: totalStats._avg.completionRate || 0,
      recentViews,
      topReels: topReels.map((r) => ({
        id: r.id,
        viewsCount: r.viewsCount,
        likesCount: r.likesCount,
        commentsCount: r.commentsCount,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error('getCreatorAnalytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};

export const getReelAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        viewsCount: true,
        uniqueViewsCount: true,
        likesCount: true,
        commentsCount: true,
        sharesCount: true,
        savesCount: true,
        avgWatchTimeMs: true,
        completionRate: true,
        durationSeconds: true,
        createdAt: true,
      },
    });

    if (!reel) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (reel.authorId !== userId) {
      res.status(403).json({ error: 'You can only view analytics for your own reels' });
      return;
    }

    const viewsBySource = await prisma.reel_views.groupBy({
      by: ['source'],
      where: { reelId },
      _count: true,
    });

    const viewsByDevice = await prisma.reel_views.groupBy({
      by: ['deviceType'],
      where: { reelId },
      _count: true,
    });

    res.json({
      viewsCount: reel.viewsCount,
      uniqueViewsCount: reel.uniqueViewsCount,
      likesCount: reel.likesCount,
      commentsCount: reel.commentsCount,
      sharesCount: reel.sharesCount,
      savesCount: reel.savesCount,
      avgWatchTimeMs: reel.avgWatchTimeMs,
      completionRate: reel.completionRate,
      durationSeconds: reel.durationSeconds,
      engagementRate:
        reel.viewsCount > 0
          ? (reel.likesCount + reel.commentsCount + reel.sharesCount) / reel.viewsCount
          : 0,
      viewsBySource: viewsBySource.map((v) => ({
        source: v.source || 'unknown',
        count: v._count,
      })),
      viewsByDevice: viewsByDevice.map((v) => ({
        device: v.deviceType || 'unknown',
        count: v._count,
      })),
      createdAt: reel.createdAt,
    });
  } catch (error) {
    console.error('getReelAnalytics error:', error);
    res.status(500).json({ error: 'Failed to fetch reel analytics' });
  }
};

export const reportReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { reason, description } = req.body;

    if (!reason) {
      res.status(400).json({ error: 'Reason is required' });
      return;
    }

    const validReasons = [
      'spam',
      'harassment',
      'violence',
      'nudity',
      'misinformation',
      'other',
    ];
    if (!validReasons.includes(reason)) {
      res.status(400).json({ error: 'Invalid reason' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    try {
      await prisma.reel_reports.create({
        data: {
          reelId,
          reporterId: userId,
          reason,
          description,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('reportReel error:', error);
    res.status(500).json({ error: 'Failed to report reel' });
  }
};

export const transcodingWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!verifyBunnyStreamSignature(req)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    const { VideoGuid, Status, LibraryId } = req.body;

    if (LibraryId !== process.env.BUNNY_STREAM_LIBRARY_ID) {
      res.status(400).json({ error: 'Invalid library ID' });
      return;
    }

    const reelRecord = await prisma.reels.findUnique({
      where: { videoId: VideoGuid },
      select: { id: true, authorId: true, status: true, scheduledAt: true },
    });

    if (!reelRecord) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const statusString = bunnyStreamService.getStatusString(Status);

    if (statusString === 'ready') {
      const videoInfo = await bunnyStreamService.getVideo(VideoGuid);
      const now = new Date();
      const isDraft = reelRecord.status === 'draft';
      const hasScheduledFuture = reelRecord.scheduledAt && new Date(reelRecord.scheduledAt) > now;
      const shouldPublish = !isDraft && !hasScheduledFuture;

      await prisma.reels.update({
        where: { id: reelRecord.id },
        data: {
          status: 'ready',
          transcodingProgress: 100,
          durationSeconds: Math.round(videoInfo.length || 0),
          width: videoInfo.width || 1080,
          height: videoInfo.height || 1920,
          fileSize: videoInfo.storageSize,
          ...(shouldPublish ? { publishedAt: now } : {}),
        },
      });

      const io = getIO();
      if (io) {
        io.to(`user:${reelRecord.authorId}`).emit('reel:processing_complete', {
          reelId: reelRecord.id,
          hlsUrl: bunnyStreamService.getHlsUrl(VideoGuid),
        });
      }
      invalidateReelCacheTags(reelRecord);
    } else if (statusString === 'failed') {
      await prisma.reels.update({
        where: { id: reelRecord.id },
        data: {
          status: 'failed',
          processingError: 'Transcoding failed',
        },
      });

      const io = getIO();
      if (io) {
        io.to(`user:${reelRecord.authorId}`).emit('reel:processing_failed', {
          reelId: reelRecord.id,
          error: 'Transcoding failed',
        });
      }
      invalidateReelCacheTags(reelRecord);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('transcodingWebhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};
