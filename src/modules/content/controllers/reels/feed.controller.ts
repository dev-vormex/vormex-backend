import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { clampPageSize } from "../../../../shared/utils/keyset-pagination.util";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import type { Prisma } from '@prisma/client';
import { prisma, JOIN_RELATIONS } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { decorateSurfaceRecommendations } from "../../../discovery/services/surface-recommendation.service";
import { AuthRequest, anonymousReelsFeedCacheKey, applyDateCursor, reelInclude, rankForYouReels, mapReelResponse, encodeDateCursor, selectReelsAdPlacements } from "./support.controller";

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

    // Authenticated responses are never cached (cacheKey is anonymous-only), so the
    // per-viewer block filter below cannot be bypassed by a shared cache entry.
    const blockedUserIds = currentUserId ? await getBlockedUserIds(currentUserId) : [];

    const cacheKey = !currentUserId && mode !== 'following'
      ? anonymousReelsFeedCacheKey(req.query as Record<string, unknown>)
      : null;

    if (mode === 'following' && currentUserId) {
      const following = await prisma.follows.findMany({
        where: { followerId: currentUserId },
        select: { followingId: true },
      });
      const blockedSet = new Set(blockedUserIds);
      const followingIds = following.map((f) => f.followingId).filter((id) => !blockedSet.has(id));

      if (followingIds.length > 0) {
        whereClause.authorId = { in: followingIds };
      } else {
        res.json({ reels: [], nextCursor: null, hasMore: false, adPlacements: [] });
        return;
      }
    } else if (blockedUserIds.length > 0) {
      whereClause.authorId = { notIn: blockedUserIds };
    }

    const feedScope = mode === 'following' && currentUserId ? `reels.feed.following:${currentUserId}` : 'reels.feed';
    applyDateCursor(whereClause, cursor, feedScope, 'publishedAt');

    const computeResponse = async () => {
      const reels = await prisma.reels.findMany({
        where: whereClause,
        include: reelInclude(currentUserId),
        relationLoadStrategy: JOIN_RELATIONS,
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
    const blockedUserIds = currentUserId ? await getBlockedUserIds(currentUserId) : [];

    const trendingOrderBy: Prisma.reelsOrderByWithRelationInput[] = [
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
      ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
    };

    let reels = await prisma.reels.findMany({
      where: {
        ...publicReadyWhere,
        publishedAt: { gte: since },
      },
      include: reelInclude(currentUserId),
      relationLoadStrategy: JOIN_RELATIONS,
      orderBy: trendingOrderBy,
      take: limit,
    });

    if (reels.length === 0) {
      reels = await prisma.reels.findMany({
        where: publicReadyWhere,
        include: reelInclude(currentUserId),
        relationLoadStrategy: JOIN_RELATIONS,
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
