import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewStory } from "../../../../shared/utils/access-control.util";
import { getIO } from "../../../../realtime/socket-registry";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { AuthRequest, sendStoryUnavailable, syncStoryViewsCount, invalidateStoryFeedCaches } from "./support.controller";

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
