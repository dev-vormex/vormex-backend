import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { getIO } from '../sockets';
import { parseStoredMusicAttachment } from '../utils/music.util';
import {
  buildStoryVisibilityWhere,
  canViewStory,
  getConnectedPeerIds,
} from '../utils/access-control.util';
import {
  assertUsersCanInteract,
  areUsersBlocked,
  enforceTrustTierLimit,
  getBlockedUserIds,
  safetyErrorResponse,
} from '../services/trust-safety.service';
import { decorateSurfaceRecommendations } from '../services/surface-recommendation.service';
import { cacheService } from '../services/cache.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const STORY_EXPIRY_HOURS = 24;
const DEFAULT_STORY_REACTION = 'LIKE';
const DEFAULT_STORY_FEED_LIMIT = 180;
const MAX_STORY_FEED_LIMIT = 300;
const MIN_STORY_FEED_LIMIT = 20;
const STORY_FEED_CACHE_VERSION = 'v1';
const STORY_FEED_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STORY_FEED_CACHE_TTL_SECONDS = 48 * 60 * 60;
const STORY_FEED_RECOMMENDATION_SESSION_TTL_MS = STORY_FEED_CACHE_TTL_SECONDS * 1000;

export function storyFeedSnapshotWindow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / STORY_FEED_SNAPSHOT_WINDOW_MS);
}

function storyFeedCacheKey(userId: string, limit: number, nowMs: number): string {
  return [
    'stories:feed',
    STORY_FEED_CACHE_VERSION,
    `user:${userId}`,
    `limit:${limit}`,
    `window:${storyFeedSnapshotWindow(nowMs)}`,
  ].join(':');
}

async function invalidateStoryFeedCaches(...tags: string[]): Promise<void> {
  await cacheService.invalidateTags(...Array.from(new Set(tags.filter(Boolean))));
}

function sendStoryUnavailable(res: Response): void {
  res.status(404).json({
    error: 'This resource is unavailable.',
    code: 'resource_unavailable',
    retryable: false,
  });
}

function getStoryViewsCount(story: any) {
  return story?._count?.story_views ?? story?.viewsCount ?? 0;
}

async function syncStoryViewsCount(storyId: string, currentViewsCount?: number) {
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

function parseStoryFeedLimit(value: unknown) {
  const parsed = parseInt(ensureString(value) || String(DEFAULT_STORY_FEED_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_STORY_FEED_LIMIT;
  return Math.min(Math.max(parsed, MIN_STORY_FEED_LIMIT), MAX_STORY_FEED_LIMIT);
}

function mapStoryToResponse(story: any, currentUserId?: string) {
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

export function pruneExpiredStoryGroups<T extends { stories?: any[]; hasUnviewed?: boolean; lastStoryAt?: unknown }>(
  groups: T[],
  nowMs: number = Date.now()
): T[] {
  return groups.flatMap((group) => {
    const stories = (Array.isArray(group.stories) ? group.stories : []).filter((story) => {
      const expiresAtMs = new Date(story?.expiresAt).getTime();
      return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
    });
    if (stories.length === 0) return [];
    return [{
      ...group,
      stories,
      hasUnviewed: stories.some((story) => !story?.isViewed),
      lastStoryAt: stories[0]?.createdAt || group.lastStoryAt,
    }];
  });
}

function normalizeStoryVisibility(value: unknown): 'PUBLIC' | 'CONNECTIONS' | 'PRIVATE' {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === 'CONNECTIONS') return 'CONNECTIONS';
  if (normalized === 'PRIVATE') return 'PRIVATE';
  return 'PUBLIC';
}

function getStoryReactionsModel() {
  return (prisma as any).story_reactions;
}

// Get stories feed - grouped by author
export const getStoriesFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    if (!currentUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const limit = parseStoryFeedLimit(req.query.limit);
    const nowMs = Date.now();
    const snapshotWindow = storyFeedSnapshotWindow(nowMs);
    const payload = await cacheService.getOrSet(
      storyFeedCacheKey(currentUserId, limit, nowMs),
      async () => {
        const stories = await prisma.stories.findMany({
          where: {
            expiresAt: { gt: new Date() },
            ...(await buildStoryVisibilityWhere(currentUserId)),
          },
          include: {
            users: {
              select: {
                id: true,
                username: true,
                name: true,
                profileImage: true,
                headline: true,
              },
            },
            story_views: {
              where: { viewerId: currentUserId },
              select: { viewerId: true },
              take: 1,
            },
            _count: {
              select: {
                story_views: true,
              },
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit,
        });

        const groupMap = new Map<string, { user: any; stories: any[]; hasUnviewed: boolean; lastStoryAt: Date }>();
        for (const story of stories) {
          const existing = groupMap.get(story.authorId);
          const storyData = mapStoryToResponse(story, currentUserId);
          if (!existing) {
            groupMap.set(story.authorId, {
              user: story.users,
              stories: [storyData],
              hasUnviewed: !storyData.isViewed,
              lastStoryAt: story.createdAt,
            });
          } else {
            existing.stories.push(storyData);
            existing.hasUnviewed = existing.hasUnviewed || !storyData.isViewed;
            if (new Date(story.createdAt).getTime() > new Date(existing.lastStoryAt).getTime()) {
              existing.lastStoryAt = story.createdAt;
            }
          }
        }

        const storyGroups = Array.from(groupMap.values())
          .map((group) => ({
            ...group,
            isOwnStory: group.user.id === currentUserId,
          }))
          .sort((left, right) => {
            if (left.isOwnStory !== right.isOwnStory) return left.isOwnStory ? -1 : 1;
            if (left.hasUnviewed !== right.hasUnviewed) return left.hasUnviewed ? -1 : 1;
            return new Date(right.lastStoryAt).getTime() - new Date(left.lastStoryAt).getTime();
          });

        const decorated = await decorateSurfaceRecommendations({
          userId: currentUserId,
          surface: 'STORIES',
          entityType: 'STORY',
          items: storyGroups,
          idOf: (group: any) => String(group.stories?.[0]?.id || group.user?.id),
          authorIdOf: (group: any) => group.user?.id,
          createdAtOf: (group: any) => group.lastStoryAt,
          pageSize: storyGroups.length || 1,
          sessionTtlMs: STORY_FEED_RECOMMENDATION_SESSION_TTL_MS,
        });
        return {
          storyGroups: decorated.items,
          recommendationSessionId: decorated.recommendationSessionId,
          requestId: decorated.requestId,
          rankerVersion: decorated.rankerVersion,
          experimentVariant: decorated.experimentVariant,
          snapshotWindow,
        };
      },
      {
        ttlSeconds: STORY_FEED_CACHE_TTL_SECONDS,
        lockTtlMs: 60_000,
        tags: ['stories:feed:global', `stories:${currentUserId}`],
      }
    );
    res.setHeader('X-Vormex-Story-Window', String(snapshotWindow));
    res.json({
      ...payload,
      storyGroups: pruneExpiredStoryGroups(payload.storyGroups || [], Date.now()),
    });
  } catch (error) {
    console.error('getStoriesFeed error:', error);
    res.status(500).json({ error: 'Failed to fetch stories feed' });
  }
};

// Create story
export const createStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const expiresAt = new Date(Date.now() + STORY_EXPIRY_HOURS * 60 * 60 * 1000);
    let mediaType = 'TEXT';
    let mediaUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    let textContent: string | null = null;
    let backgroundColor: string | null = null;
    let category = 'GENERAL';
    let visibility = 'PUBLIC';
    let linkUrl: string | null = null;
    let linkTitle: string | null = null;
    let musicMetadata: any = null;

    // Handle FormData (media upload)
    const file = req.file as Express.Multer.File | undefined;
    if (file) {
      const isVideo = file.mimetype?.startsWith('video/');
      const isImage = file.mimetype?.startsWith('image/');
      if (isVideo) {
        mediaType = 'VIDEO';
        mediaUrl = await bunnyStorageService.uploadStoryVideo(file.buffer, userId, file.mimetype || 'video/mp4');
        thumbnailUrl = mediaUrl;
      } else if (isImage) {
        mediaType = 'IMAGE';
        mediaUrl = await bunnyStorageService.uploadStoryImage(file.buffer, userId, file.mimetype || 'image/jpeg');
        thumbnailUrl = mediaUrl;
      } else {
        res.status(400).json({ error: 'Invalid file type. Use image or video.' });
        return;
      }
      textContent = (req.body.textContent as string) || null;
      category = (req.body.category as string) || 'GENERAL';
      visibility = normalizeStoryVisibility(req.body.visibility);
      linkUrl = (req.body.linkUrl as string) || null;
      linkTitle = (req.body.linkTitle as string) || null;
      musicMetadata = parseStoredMusicAttachment(req.body.music);
    } else {
      // JSON body (text-only story)
      const body = req.body as Record<string, any>;
      mediaType = (body.mediaType as string) || 'TEXT';
      textContent = (body.textContent as string) || null;
      backgroundColor = (body.backgroundColor as string) || null;
      category = (body.category as string) || 'GENERAL';
      visibility = normalizeStoryVisibility(body.visibility);
      linkUrl = (body.linkUrl as string) || null;
      linkTitle = (body.linkTitle as string) || null;
      musicMetadata = parseStoredMusicAttachment(body.music);

      if (!textContent && mediaType === 'TEXT') {
        res.status(400).json({ error: 'Text content is required for text stories' });
        return;
      }
    }

    const story = await prisma.stories.create({
      data: {
        id: crypto.randomUUID(),
        authorId: userId,
        mediaType,
        mediaUrl,
        thumbnailUrl,
        textContent,
        backgroundColor,
        category,
        visibility,
        linkUrl,
        linkTitle,
        musicMetadata,
        expiresAt,
      },
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            headline: true,
          },
        },
      },
    });

    const storyData = mapStoryToResponse(story, userId);

    // Emit real-time event for story carousel
    const io = getIO();
    if (io) {
      const storyCreatedPayload = {
        story: storyData,
        author: (story as any).users,
        timestamp: story.createdAt,
      };

      io.to(`user:${userId}`).emit('story:created', storyCreatedPayload);
      if (visibility === 'PUBLIC') {
        const blockedUserIds = new Set(await getBlockedUserIds(userId));
        const sockets = await io.fetchSockets();
        const recipientIds = new Set(
          sockets
            .map((socket) => String(socket.data?.userId || ''))
            .filter((recipientId) => recipientId && recipientId !== userId && !blockedUserIds.has(recipientId))
        );
        recipientIds.forEach((recipientId) => {
          io.to(`user:${recipientId}`).emit('story:created', storyCreatedPayload);
        });
      } else if (visibility === 'CONNECTIONS') {
        const blockedUserIds = new Set(await getBlockedUserIds(userId));
        const peerIds = (await getConnectedPeerIds(userId)).filter((peerId) => !blockedUserIds.has(peerId));
        peerIds.forEach((peerId) => {
          io.to(`user:${peerId}`).emit('story:created', storyCreatedPayload);
        });
      }
    }

    await invalidateStoryFeedCaches('stories:feed:global', `stories:${userId}`);
    res.status(201).json({ message: 'Story created', story: storyData });
  } catch (error) {
    console.error('createStory error:', error);
    res.status(500).json({ error: 'Failed to create story' });
  }
};

// Get single story
export const getStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }

    const story = await prisma.stories.findFirst({
      where: {
        id: storyId,
        expiresAt: { gt: new Date() },
        ...(await buildStoryVisibilityWhere(currentUserId)),
      },
      include: {
        users: { select: { id: true, username: true, name: true, profileImage: true, headline: true } },
        ...(currentUserId
          ? {
              story_views: {
                where: { viewerId: currentUserId },
                select: { viewerId: true },
                take: 1,
              },
            }
          : {}),
        _count: {
          select: {
            story_views: true,
          },
        },
      },
    });

    if (!story) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    res.json({ story: mapStoryToResponse(story, currentUserId), isOwn: story.authorId === currentUserId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch story' });
  }
};

// Get my stories
export const getMyStories = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const includeExpired = req.query.includeExpired === 'true';
    const where: any = { authorId: userId };
    if (!includeExpired) {
      where.expiresAt = { gt: new Date() };
    }

    const stories = await prisma.stories.findMany({
      where,
      include: {
        story_views: {
          where: { viewerId: userId },
          select: { viewerId: true },
          take: 1,
        },
        _count: {
          select: {
            story_views: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ stories: stories.map((s) => mapStoryToResponse(s, userId)) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch my stories' });
  }
};

// Delete story
export const deleteStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }

    const story = await prisma.stories.findFirst({ where: { id: storyId } });
    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    if (story.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own stories' });
      return;
    }

    await prisma.stories.delete({ where: { id: storyId } });

    const io = getIO();
    if (io) {
      io.emit('story:deleted', { storyId, authorId: userId, timestamp: new Date() });
    }

    await invalidateStoryFeedCaches('stories:feed:global', `stories:${userId}`);
    res.json({ message: 'Story deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete story' });
  }
};

// Get user stories
export const getUserStories = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }
    const currentUserId = req.user?.userId;
    if (currentUserId && currentUserId !== userId && await areUsersBlocked(currentUserId, userId)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    const stories = await prisma.stories.findMany({
      where: {
        authorId: userId,
        expiresAt: { gt: new Date() },
        ...(await buildStoryVisibilityWhere(currentUserId)),
      },
      include: {
        users: { select: { id: true, username: true, name: true, profileImage: true, headline: true } },
        ...(currentUserId
          ? {
              story_views: {
                where: { viewerId: currentUserId },
                select: { viewerId: true },
                take: 1,
              },
            }
          : {}),
        _count: {
          select: {
            story_views: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (stories.length === 0) {
      res.json({ hasStories: false, user: null, hasUnviewed: false, stories: [] });
      return;
    }

    const firstStoryWithAuthor = stories[0] as typeof stories[0] & { users: unknown };
    const mappedStories = stories.map((s) => mapStoryToResponse(s, currentUserId));
    res.json({
      hasStories: true,
      user: firstStoryWithAuthor.users,
      hasUnviewed: mappedStories.some((story) => !story.isViewed),
      stories: mappedStories,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user stories' });
  }
};

// View story - Instagram-style unique view counting
export const viewStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const viewerId = req.user?.userId;
    if (!viewerId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }

    const story = await prisma.stories.findFirst({
      where: { id: storyId, expiresAt: { gt: new Date() } },
    });
    if (!story) {
      sendStoryUnavailable(res);
      return;
    }
    if (!(await canViewStory(story, viewerId))) {
      sendStoryUnavailable(res);
      return;
    }

    // Don't count owner views
    if (story.authorId === viewerId) {
      const viewsCount = await syncStoryViewsCount(storyId, story.viewsCount);
      res.json({ message: 'Story viewed (own story)', viewsCount, isNewView: false });
      return;
    }

    // Try to create a unique view record - upsert pattern
    // If already exists, this will not create a duplicate (unique constraint)
    let isNewView = false;
    try {
      await prisma.story_views.create({
        data: {
          storyId,
          viewerId,
        },
      });
      isNewView = true;
    } catch (e: any) {
      // Unique constraint violation - user already viewed this story
      if (e.code === 'P2002') {
        isNewView = false;
      } else {
        throw e;
      }
    }

    // Keep the denormalized story.viewsCount aligned with actual unique viewer rows.
    const viewsCount = await syncStoryViewsCount(storyId, story.viewsCount);

    if (isNewView) {
      // Emit real-time view notification to story author
      const io = getIO();
      if (io) {
        io.to(`user:${story.authorId}`).emit('story:viewed', {
          storyId,
          viewerId,
          viewsCount,
          timestamp: new Date(),
        });
      }
    }

    await invalidateStoryFeedCaches(`stories:${viewerId}`, `stories:${story.authorId}`);
    res.json({ message: 'Story viewed', viewsCount, isNewView });
  } catch (error) {
    console.error('viewStory error:', error);
    res.status(500).json({ error: 'Failed to record story view' });
  }
};

// Get story viewers - sorted by latest first
export const getStoryViewers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }

    // Only story owner can see viewers
    const story = await prisma.stories.findFirst({
      where: { id: storyId },
    });
    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    if (story.authorId !== userId) {
      res.status(403).json({ error: 'Only story owner can view viewers list' });
      return;
    }

    // Pagination
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const blockedUserIds = await getBlockedUserIds(userId);
    const visibleViewWhere = {
      storyId,
      ...(blockedUserIds.length > 0 ? { viewerId: { notIn: blockedUserIds } } : {}),
    };

    const [views, totalCount, rawTotalCount] = await Promise.all([
      prisma.story_views.findMany({
        where: visibleViewWhere,
        orderBy: { viewedAt: 'desc' },
        take: limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      }),
      prisma.story_views.count({
        where: visibleViewWhere,
      }),
      prisma.story_views.count({ where: { storyId } }),
    ]);

    const hasMore = views.length > limit;
    const viewsToReturn = hasMore ? views.slice(0, -1) : views;

    if (story.viewsCount !== rawTotalCount) {
      await prisma.stories.update({
        where: { id: storyId },
        data: { viewsCount: rawTotalCount },
      });
    }

    // Get viewer details
    const viewerIds = viewsToReturn.map((v) => v.viewerId);
    const users = await prisma.user.findMany({
      where: { id: { in: viewerIds } },
      select: {
        id: true,
        name: true,
        username: true,
        profileImage: true,
        headline: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));
    const viewers = viewsToReturn.map((v) => ({
      id: v.id,
      viewedAt: v.viewedAt.toISOString(),
      user: userMap.get(v.viewerId) || null,
    }));

    res.json({
      viewers,
      totalCount,
      nextCursor: hasMore ? viewsToReturn[viewsToReturn.length - 1]?.id : null,
      hasMore,
    });
  } catch (error) {
    console.error('getStoryViewers error:', error);
    res.status(500).json({ error: 'Failed to fetch story viewers' });
  }
};

// React to story - also sends as DM to story owner
export const reactToStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const storyId = ensureString(req.params.storyId);
    const { reactionType } = req.body; // emoji like "❤️", "🔥", etc.
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }
    const story = await prisma.stories.findFirst({
      where: { id: storyId, expiresAt: { gt: new Date() } },
      include: { users: { select: { id: true, name: true, username: true } } },
    });
    if (!story) {
      sendStoryUnavailable(res);
      return;
    }
    if (!(await canViewStory(story, userId))) {
      sendStoryUnavailable(res);
      return;
    }

    const reactionModel = getStoryReactionsModel();
    const normalizedReaction = typeof reactionType === 'string' && reactionType.trim().length > 0
      ? reactionType.trim()
      : DEFAULT_STORY_REACTION;
    const existingReaction = await reactionModel.findUnique({
      where: { storyId_userId: { storyId, userId } },
      select: { reactionType: true },
    });
    
    // Don't send DM to self
    if (story.authorId !== userId) {
      await assertUsersCanInteract(userId, story.authorId, 'story reaction');
      await enforceTrustTierLimit(userId, 'dm');

      // Get or create conversation with story owner
      let conversation = await prisma.conversations.findFirst({
        where: {
          OR: [
            { participant1Id: userId, participant2Id: story.authorId },
            { participant1Id: story.authorId, participant2Id: userId },
          ],
        },
      });
      
      if (!conversation) {
        conversation = await prisma.conversations.create({
          data: {
            participant1Id: userId,
            participant2Id: story.authorId,
          },
        });
      }
      
      // Get sender info
      const sender = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, username: true, profileImage: true },
      });
      
      // Create message with story reaction
      const emoji = normalizedReaction;
      const storyData = {
        storyId: story.id,
        mediaUrl: story.mediaUrl,
        mediaType: story.mediaType,
        thumbnailUrl: story.thumbnailUrl,
        textContent: story.textContent,
        backgroundColor: story.backgroundColor,
        expiresAt: story.expiresAt.toISOString(),
        reaction: emoji,
      };
      
      const chatMessage = await prisma.messages.create({
        data: {
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          senderId: userId,
          receiverId: story.authorId,
          content: `Reacted ${emoji} to your story`,
          contentType: 'story_reaction',
          mediaUrl: story.thumbnailUrl || story.mediaUrl,
          mediaType: 'story',
          fileName: JSON.stringify(storyData),
          status: 'SENT',
          updatedAt: new Date(),
        },
      });
      
      // Update conversation lastMessageAt
      await prisma.conversations.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      
      // Send real-time message to recipient
      const io = getIO();
      if (io) {
        const messagePayload = {
          id: chatMessage.id,
          conversationId: conversation.id,
          senderId: userId,
          receiverId: story.authorId,
          content: chatMessage.content,
          contentType: 'story_reaction',
          mediaUrl: chatMessage.mediaUrl,
          mediaType: 'story',
          storyData,
          story: {
            id: story.id,
            mediaUrl: story.mediaUrl,
            mediaType: story.mediaType,
            thumbnailUrl: story.thumbnailUrl,
            textContent: story.textContent,
            backgroundColor: story.backgroundColor,
            expiresAt: story.expiresAt.toISOString(),
            available: true,
          },
          status: 'SENT',
          createdAt: chatMessage.createdAt.toISOString(),
          sender,
        };
        
        io.to(`chat:${conversation.id}`).emit('chat:new_message', {
          conversationId: conversation.id,
          message: messagePayload,
        });
        io.to(`user:${story.authorId}`).emit('chat:new_message', {
          conversationId: conversation.id,
          message: messagePayload,
        });
      }
    }
    
    await reactionModel.upsert({
      where: { storyId_userId: { storyId, userId } },
      create: { storyId, userId, reactionType: normalizedReaction },
      update: { reactionType: normalizedReaction },
    });
    const reactionsCount = await reactionModel.count({ where: { storyId } });
    await prisma.stories.update({
      where: { id: storyId },
      data: { reactionsCount },
    });
    await invalidateStoryFeedCaches(`stories:${userId}`, `stories:${story.authorId}`);
    res.json({
      success: true,
      message: existingReaction ? 'Reaction updated' : 'Reaction added',
      reactionType: normalizedReaction,
      reactionsCount,
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('React to story error:', error);
    res.status(500).json({ error: 'Failed to react to story' });
  }
};

// Remove story reaction
export const removeStoryReaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }
    const story = await prisma.stories.findFirst({ where: { id: storyId } });
    if (!story) {
      sendStoryUnavailable(res);
      return;
    }
    if (!(await canViewStory(story, userId))) {
      sendStoryUnavailable(res);
      return;
    }

    const reactionModel = getStoryReactionsModel();
    await reactionModel.deleteMany({ where: { storyId, userId } });
    const newCount = await reactionModel.count({ where: { storyId } });
    await prisma.stories.update({
      where: { id: storyId },
      data: { reactionsCount: newCount },
    });
    await invalidateStoryFeedCaches(`stories:${userId}`, `stories:${story.authorId}`);
    res.json({ message: 'Reaction removed', reactionsCount: newCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
};

// Reply to story - sends as DM to story owner
export const replyToStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }
    const { content, mediaUrl } = req.body;
    if (!content && !mediaUrl) {
      res.status(400).json({ error: 'Reply content is required' });
      return;
    }
    
    const story = await prisma.stories.findFirst({ 
      where: { id: storyId, expiresAt: { gt: new Date() } },
      include: { users: { select: { id: true, name: true, username: true } } },
    });
    if (!story) {
      sendStoryUnavailable(res);
      return;
    }
    if (!(await canViewStory(story, userId))) {
      sendStoryUnavailable(res);
      return;
    }
    
    // Don't send DM to self
    if (story.authorId === userId) {
      res.status(400).json({ error: 'Cannot reply to your own story' });
      return;
    }

    await assertUsersCanInteract(userId, story.authorId, 'story reply');
    await enforceTrustTierLimit(userId, 'dm');
    
    // Get or create conversation with story owner
    let conversation = await prisma.conversations.findFirst({
      where: {
        OR: [
          { participant1Id: userId, participant2Id: story.authorId },
          { participant1Id: story.authorId, participant2Id: userId },
        ],
      },
    });
    
    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          participant1Id: userId,
          participant2Id: story.authorId,
        },
      });
    }
    
    // Get sender info
    const sender = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, username: true, profileImage: true },
    });
    
    // Create message with story reply
    const storyData = {
      storyId: story.id,
      mediaUrl: story.mediaUrl,
      mediaType: story.mediaType,
      thumbnailUrl: story.thumbnailUrl,
      textContent: story.textContent,
      backgroundColor: story.backgroundColor,
      expiresAt: story.expiresAt.toISOString(),
    };
    
    const chatMessage = await prisma.messages.create({
      data: {
        id: crypto.randomUUID(),
        conversationId: conversation.id,
        senderId: userId,
        receiverId: story.authorId,
        content: content || '',
        contentType: 'story_reply',
        mediaUrl: mediaUrl || story.thumbnailUrl || story.mediaUrl,
        mediaType: 'story',
        fileName: JSON.stringify(storyData),
        status: 'SENT',
        updatedAt: new Date(),
      },
    });
    
    // Update conversation lastMessageAt
    await prisma.conversations.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    
    // Send real-time message to recipient
    const io = getIO();
    if (io) {
      const messagePayload = {
        id: chatMessage.id,
        conversationId: conversation.id,
        senderId: userId,
        receiverId: story.authorId,
        content: chatMessage.content,
        contentType: 'story_reply',
        mediaUrl: chatMessage.mediaUrl,
        mediaType: 'story',
        storyData,
        story: {
          id: story.id,
          mediaUrl: story.mediaUrl,
          mediaType: story.mediaType,
          thumbnailUrl: story.thumbnailUrl,
          textContent: story.textContent,
          backgroundColor: story.backgroundColor,
          expiresAt: story.expiresAt.toISOString(),
          available: true,
        },
        status: 'SENT',
        createdAt: chatMessage.createdAt.toISOString(),
        sender,
      };
      
      io.to(`chat:${conversation.id}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });
      io.to(`user:${story.authorId}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });
    }
    
    res.json({
      success: true,
      message: 'Reply sent',
      reply: { 
        id: chatMessage.id, 
        content: content || '', 
        mediaUrl, 
        conversationId: conversation.id,
        createdAt: chatMessage.createdAt 
      },
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Reply to story error:', error);
    res.status(500).json({ error: 'Failed to reply to story' });
  }
};

// Get story replies
export const getStoryReplies = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ replies: [] });
};

// Create highlight
export const createHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { name, coverImage, storyIds } = req.body;
    const requestedStoryIds = Array.isArray(storyIds) ? storyIds.map(String).filter(Boolean) : [];
    if (requestedStoryIds.length > 0) {
      const ownedStories = await prisma.stories.count({
        where: { id: { in: requestedStoryIds }, authorId: userId },
      });
      if (ownedStories !== new Set(requestedStoryIds).size) {
        res.status(403).json({ error: 'Highlights can only include your own stories' });
        return;
      }
    }
    res.json({ message: 'Highlight created', highlight: { id: 'temp', name, coverImage, storyIds } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create highlight' });
  }
};

// Get user highlights
export const getUserHighlights = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ highlights: [] });
};

// Get highlight stories
export const getHighlightStories = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ highlight: null });
};

// Update highlight
export const updateHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ message: 'Highlight updated', highlight: null });
};

// Delete highlight
export const deleteHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ message: 'Highlight deleted' });
};

// Add story to highlight
export const addStoryToHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const storyId = ensureString(req.params.storyId);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!storyId) {
    res.status(400).json({ error: 'Story ID is required' });
    return;
  }
  const story = await prisma.stories.findFirst({ where: { id: storyId, authorId: userId }, select: { id: true } });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ message: 'Story added to highlight' });
};

// Remove story from highlight
export const removeStoryFromHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const storyId = ensureString(req.params.storyId);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!storyId) {
    res.status(400).json({ error: 'Story ID is required' });
    return;
  }
  const story = await prisma.stories.findFirst({ where: { id: storyId, authorId: userId }, select: { id: true } });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ message: 'Story removed from highlight' });
};

// Archive story
export const archiveStory = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const storyId = ensureString(req.params.storyId);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!storyId) {
    res.status(400).json({ error: 'Story ID is required' });
    return;
  }
  const story = await prisma.stories.findFirst({ where: { id: storyId, authorId: userId }, select: { id: true } });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ message: 'Story archived' });
};

// Get archived stories
export const getArchivedStories = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ stories: [] });
};
