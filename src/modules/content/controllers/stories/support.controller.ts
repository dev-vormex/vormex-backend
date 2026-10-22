
import { Response } from "express";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { parseStoredMusicAttachment } from "../../utils/music.util";


export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export const STORY_EXPIRY_HOURS = 24;

export const DEFAULT_STORY_REACTION = 'LIKE';

export const DEFAULT_STORY_FEED_LIMIT = 180;

export const MAX_STORY_FEED_LIMIT = 300;

export const MIN_STORY_FEED_LIMIT = 20;

export const STORY_FEED_CACHE_VERSION = 'v1';

export const STORY_FEED_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STORY_FEED_CACHE_TTL_SECONDS = 48 * 60 * 60;

export const STORY_FEED_RECOMMENDATION_SESSION_TTL_MS = STORY_FEED_CACHE_TTL_SECONDS * 1000;

export function storyFeedCacheKey(userId: string, limit: number, nowMs: number): string {
  return [
    'stories:feed',
    STORY_FEED_CACHE_VERSION,
    `user:${userId}`,
    `limit:${limit}`,
    `window:${storyFeedSnapshotWindow(nowMs)}`,
  ].join(':');
}

export async function invalidateStoryFeedCaches(...tags: string[]): Promise<void> {
  await cacheService.invalidateTags(...Array.from(new Set(tags.filter(Boolean))));
}

export function sendStoryUnavailable(res: Response): void {
  res.status(404).json({
    error: 'This resource is unavailable.',
    code: 'resource_unavailable',
    retryable: false,
  });
}

export function getStoryViewsCount(story: any) {
  return story?._count?.story_views ?? story?.viewsCount ?? 0;
}

export async function syncStoryViewsCount(storyId: string, currentViewsCount?: number) {
  const viewsCount = await prisma.story_views.count({
    where: { storyId },
  });

  if ((currentViewsCount ?? 0) !== viewsCount) {
    await prisma.stories.update({
      where: { id: storyId },
      data: { viewsCount },
    });
  }

  return viewsCount;
}

export function parseStoryFeedLimit(value: unknown) {
  const parsed = parseInt(ensureString(value) || String(DEFAULT_STORY_FEED_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_STORY_FEED_LIMIT;
  return Math.min(Math.max(parsed, MIN_STORY_FEED_LIMIT), MAX_STORY_FEED_LIMIT);
}

export function mapStoryToResponse(story: any, currentUserId?: string) {
  const music = parseStoredMusicAttachment(story.musicMetadata);
  const isOwn = currentUserId ? story.authorId === currentUserId : false;
  const isViewed = isOwn || Boolean(story?.story_views?.length);

  return {
    id: story.id,
    mediaUrl: story.mediaUrl || '',
    mediaType: story.mediaType,
    thumbnailUrl: story.thumbnailUrl,
    duration: 0,
    category: story.category,
    backgroundColor: story.backgroundColor,
    textContent: story.textContent,
    textPosition: null,
    textStyle: null,
    stickers: null,
    filters: null,
    music,
    musicUrl: music?.audioUrl ?? null,
    musicTitle: music?.title ?? null,
    musicArtist: music?.artist ?? null,
    linkUrl: story.linkUrl,
    linkTitle: story.linkTitle,
    visibility: story.visibility,
    viewsCount: getStoryViewsCount(story),
    reactionsCount: story.reactionsCount || 0,
    repliesCount: 0,
    isViewed,
    userReaction: null,
    isOwn,
    expiresAt: story.expiresAt,
    createdAt: story.createdAt,
  };
}

export function normalizeStoryVisibility(value: unknown): 'PUBLIC' | 'CONNECTIONS' | 'PRIVATE' {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === 'CONNECTIONS') return 'CONNECTIONS';
  if (normalized === 'PRIVATE') return 'PRIVATE';
  return 'PUBLIC';
}

export function getStoryReactionsModel() {
  return (prisma as any).story_reactions;
}

export function storyFeedSnapshotWindow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / STORY_FEED_SNAPSHOT_WINDOW_MS);
}
