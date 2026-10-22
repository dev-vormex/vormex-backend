import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { clampPageSize } from "../../../../shared/utils/keyset-pagination.util";
import { prisma, JOIN_RELATIONS } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { AuthRequest, applyDateCursor, reelInclude, mapReelResponse, encodeDateCursor, isUniqueViolation } from "./support.controller";

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
