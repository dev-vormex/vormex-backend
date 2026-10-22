import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { getBlockedUserIds, areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { prisma, JOIN_RELATIONS } from "../../../../config/prisma";
import { clampPageSize, dateDescKeysetWhere, decodeKeysetCursor } from "../../../../shared/utils/keyset-pagination.util";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { AuthRequest, applyDateCursor, reelInclude, mapReelResponse, encodeDateCursor } from "./support.controller";

export const getReelsByHashtag = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const hashtag = ensureString(req.params.hashtag);
    const cursor = ensureString(req.query.cursor);
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);

    const blockedUserIds = currentUserId ? await getBlockedUserIds(currentUserId) : [];
    const whereClause: any = {
        status: 'ready',
        visibility: 'public',
        publishedAt: { not: null },
        hashtags: { has: hashtag },
        ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
    };
    const scope = `reels.hashtag:${hashtag}`;
    applyDateCursor(whereClause, cursor, scope);
    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      relationLoadStrategy: JOIN_RELATIONS,
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

    const blockedUserIds = currentUserId ? await getBlockedUserIds(currentUserId) : [];
    const whereClause: any = {
        status: 'ready',
        visibility: 'public',
        publishedAt: { not: null },
        audioId,
        ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
    };
    const scope = `reels.audio:${audioId}`;
    applyDateCursor(whereClause, cursor, scope);
    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      relationLoadStrategy: JOIN_RELATIONS,
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
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }
    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);

    if (currentUserId && currentUserId !== userId && await areUsersBlocked(currentUserId, userId)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    const whereClause: any = {
      authorId: userId,
      status: 'ready',
    };

    if (currentUserId !== userId) {
      whereClause.visibility = 'public';
      whereClause.publishedAt = { not: null };
    }
    const scope = `reels.user:${userId}:${currentUserId === userId ? 'self' : 'public'}`;
    applyDateCursor(whereClause, cursor, scope);

    const reels = await prisma.reels.findMany({
      where: whereClause,
      include: reelInclude(currentUserId),
      relationLoadStrategy: JOIN_RELATIONS,
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
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    if (currentUserId !== userId) {
      res.status(403).json({ error: 'You can only view your own liked reels' });
      return;
    }

    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);
    const scope = `reels.liked:${userId}`;
    const cursorWhere = dateDescKeysetWhere(decodeKeysetCursor(cursor, scope), 'createdAt');

    const likes = await prisma.reel_likes.findMany({
      relationLoadStrategy: JOIN_RELATIONS,
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
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    if (currentUserId !== userId) {
      res.status(403).json({ error: 'You can only view your own saved reels' });
      return;
    }

    const cursor = ensureString(req.query.cursor);
    const limit = clampPageSize(req.query.limit, 20, 50);
    const scope = `reels.saved:${userId}`;
    const cursorWhere = dateDescKeysetWhere(decodeKeysetCursor(cursor, scope), 'createdAt');

    const saves = await prisma.reel_saves.findMany({
      relationLoadStrategy: JOIN_RELATIONS,
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
      relationLoadStrategy: JOIN_RELATIONS,
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
