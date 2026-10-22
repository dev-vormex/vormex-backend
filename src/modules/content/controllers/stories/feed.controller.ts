import { Response } from "express";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";
import { buildStoryVisibilityWhere } from "../../../../shared/utils/access-control.util";
import { decorateSurfaceRecommendations } from "../../../discovery/services/surface-recommendation.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { storyFeedSnapshotWindow, AuthRequest, parseStoryFeedLimit, storyFeedCacheKey, mapStoryToResponse, STORY_FEED_RECOMMENDATION_SESSION_TTL_MS, STORY_FEED_CACHE_TTL_SECONDS } from "./support.controller";



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
