
import { Request } from "express";
import { Prisma } from "@prisma/client";
import { createHmac, timingSafeEqual } from "crypto";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { decodeKeysetCursor, dateDescKeysetWhere, encodeKeysetCursor } from "../../../../shared/utils/keyset-pagination.util";
import { selectManagedAdPlacements } from "../../../ads/services/managed-ad.service";
import { prisma } from "../../../../config/prisma";

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export const reelCommentAuthorSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
};

export function verifyBunnyStreamSignature(req: Request): boolean {
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

export function mapReelCommentAuthor(author: any) {
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

export function mapReelComment(comment: any, currentUserId?: string) {
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

export function normalizeMentionUsernames(content: string, mentions?: unknown): string[] {
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

export function mapReelResponse(reel: any, currentUserId?: string) {
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

export const reelInclude = (currentUserId?: string) => ({
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

export function normalizeCacheQuery(query: Record<string, unknown>): string {
  return Object.entries(query)
    .map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String).sort().join(',') : String(value ?? ''),
    ])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export function anonymousReelsFeedCacheKey(query: Record<string, unknown>): string {
  return `reels:feed:public:${normalizeCacheQuery(query) || 'default'}`;
}

export function invalidateReelsFeedCache(): void {
  cacheService.invalidateTags('reels:feed').catch(() => undefined);
}

export function invalidateReelCacheTags(reel: { id: string; authorId: string }): void {
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

export function applyDateCursor(whereClause: any, cursorValue: unknown, scope: string, fieldName = 'createdAt'): void {
  const cursor = decodeKeysetCursor(cursorValue, scope);
  const cursorWhere = dateDescKeysetWhere(cursor, fieldName);
  if (!cursorWhere) return;
  whereClause.AND = [...(Array.isArray(whereClause.AND) ? whereClause.AND : []), cursorWhere];
}

export function encodeDateCursor(scope: string, item: any, fieldName = 'createdAt'): string | null {
  const value = item?.[fieldName];
  if (!item?.id || !value) return null;
  return encodeKeysetCursor({
    scope,
    id: item.id,
    t: new Date(value).toISOString(),
  });
}

export async function selectReelsAdPlacements(
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


export function safeJsonParse<T>(val: string | undefined, fallback: T): T {
  if (!val) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

export function boundedNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function reelForYouScore(reel: any): number {
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

export function rankForYouReels(reels: any[]): any[] {
  return [...reels].sort((a, b) => {
    const delta = reelForYouScore(b) - reelForYouScore(a);
    if (Math.abs(delta) > 0.0001) return delta;
    return new Date(b.publishedAt || b.createdAt).getTime() - new Date(a.publishedAt || a.createdAt).getTime();
  });
}

export /**
 * Client-supplied descriptive fields accepted by POST /reels/upload-complete (the same
 * ones createReel accepts from its multipart body). Everything else in the request body
 * is ignored so the client can never set id, authorId, status, publishedAt, counters,
 * isFeatured-style flags or any other server-controlled column.
 */
const REEL_UPLOAD_METADATA_STRING_ARRAY_KEYS = ['mentions', 'skills', 'topics'] as const;

export const REEL_UPLOAD_METADATA_BOOLEAN_KEYS = [
  'allowComments',
  'allowDuets',
  'allowStitch',
  'allowDownload',
  'allowSharing',
] as const;

export const REEL_UPLOAD_METADATA_STRING_KEYS = [
  'category',
  'codeSnippet',
  'codeLanguage',
  'codeFileName',
  'repoUrl',
] as const;

export function pickReelUploadMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!metadata || typeof metadata !== 'object') return picked;
  for (const key of REEL_UPLOAD_METADATA_STRING_ARRAY_KEYS) {
    const value = metadata[key];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) picked[key] = value;
  }
  for (const key of REEL_UPLOAD_METADATA_BOOLEAN_KEYS) {
    const value = metadata[key];
    if (typeof value === 'boolean') picked[key] = value;
  }
  for (const key of REEL_UPLOAD_METADATA_STRING_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string') picked[key] = value;
  }
  return picked;
}

export const VIEW_BATCH_MAX_ITEMS = Number(process.env.REELS_VIEW_BATCH_MAX_ITEMS || 500);

export let viewBatch: Map<string, { reelId: string; userId?: string; watchTimeMs: number; completed: boolean; source?: string }[]> = new Map();

export let viewBatchTimeout: NodeJS.Timeout | null = null;

export let viewBatchItemCount = 0;

export function incrementViewBatchItemCount(): void {
  viewBatchItemCount += 1;
}

export function setViewBatchTimeout(timeout: NodeJS.Timeout | null): void {
  viewBatchTimeout = timeout;
}

export async function flushViewBatch() {
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
