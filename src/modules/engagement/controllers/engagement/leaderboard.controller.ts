import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";
import { AuthRequest, TOP_NETWORKERS_DEFAULT_LIMIT, TOP_NETWORKERS_MAX_LIMIT, getWeekStart, TOP_NETWORKERS_CACHE_TTL_SECONDS, TOP_NETWORKERS_CACHE_TAG } from "./support.controller";

// ======================
// LEADERBOARD (Social Proof) - Top Networkers Algorithm
// ======================
export const getLeaderboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.user?.userId);
    const requestedPeriod = ensureString(req.query.period);
    const period = requestedPeriod === 'month' ? 'month' : 'week';
    const requestedLimit = parseInt(ensureString(req.query.limit) || '', 10);
    const limitNum = Math.min(
      Math.max(requestedLimit || TOP_NETWORKERS_DEFAULT_LIMIT, 1),
      TOP_NETWORKERS_MAX_LIMIT
    );
    const cacheKey = `engagement:leaderboard:${period}:limit:${limitNum}:user:${userId || 'anonymous'}`;
    const cached = await cacheService.get<{ data: any }>(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.json(cached);
      return;
    }

    // Calculate date range based on period
    const now = new Date();
    let startDate: Date;
    
    if (period === 'month') {
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    } else {
      startDate = getWeekStart();
    }

    // Scoring Algorithm:
    // - Each accepted connection in period: 100 points
    // - Each sent connection (pending): 20 points
    // - Bonus multiplier for consistent networking
    
    // Get users with accepted connections in period (both as requester and addressee)
    const connectionsInPeriod = await prisma.connections.findMany({
      where: {
        status: 'accepted',
        updatedAt: { gte: startDate },
      },
      select: {
        requesterId: true,
        addresseeId: true,
        updatedAt: true,
      },
    });

    // Count connections per user (both sent and received accepted connections)
    const userConnectionCounts: Map<string, { accepted: number; pending: number }> = new Map();
    
    for (const conn of connectionsInPeriod) {
      // Count for requester
      const requesterData = userConnectionCounts.get(conn.requesterId) || { accepted: 0, pending: 0 };
      requesterData.accepted++;
      userConnectionCounts.set(conn.requesterId, requesterData);
      
      // Count for addressee
      const addresseeData = userConnectionCounts.get(conn.addresseeId) || { accepted: 0, pending: 0 };
      addresseeData.accepted++;
      userConnectionCounts.set(conn.addresseeId, addresseeData);
    }

    // Get pending connections count for extra engagement credit
    const pendingConnections = await prisma.connections.findMany({
      where: {
        status: 'pending',
        createdAt: { gte: startDate },
      },
      select: {
        requesterId: true,
      },
    });

    for (const conn of pendingConnections) {
      const data = userConnectionCounts.get(conn.requesterId) || { accepted: 0, pending: 0 };
      data.pending++;
      userConnectionCounts.set(conn.requesterId, data);
    }

    // Calculate scores and sort
    const userScores: Array<{ userId: string; score: number; connectionsThisPeriod: number }> = [];
    
    for (const [uId, counts] of userConnectionCounts.entries()) {
      // Score formula: 100 points per accepted, 20 per pending (shows initiative)
      const score = (counts.accepted * 100) + (counts.pending * 20);
      if (score > 0) {
        userScores.push({
          userId: uId,
          score,
          connectionsThisPeriod: counts.accepted,
        });
      }
    }
    
    // Sort by score descending
    userScores.sort((a, b) => b.score - a.score);

    // Get user details for top users
    const topUserIds = userScores.slice(0, limitNum).map(u => u.userId);
    
    const users = await prisma.user.findMany({
      where: {
        id: { in: topUserIds },
        isBanned: false,
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
      },
    });

    // Create user lookup map
    const userMap = new Map(users.map(u => [u.id, u]));

    type LeaderboardUserEntry = {
      rank: number;
      userId: string;
      username: string | null;
      name: string;
      profileImage: string | null;
      headline: string | null;
      score: number;
      connectionsThisPeriod: number;
      isCurrentUser: boolean;
    };

    // Build leaderboard with real, visible users only.
    const leaderboardUsers: LeaderboardUserEntry[] = [];
    for (const uId of topUserIds) {
      const user = userMap.get(uId);
      if (!user) continue;

      const scoreData = userScores.find(s => s.userId === uId)!;
      leaderboardUsers.push({
        rank: leaderboardUsers.length + 1,
        userId: uId,
        username: user.username,
        name: user.name || 'Vormex User',
        profileImage: user.profileImage,
        headline: user.headline || null,
        score: scoreData.score,
        connectionsThisPeriod: scoreData.connectionsThisPeriod,
        isCurrentUser: uId === userId,
      });
    }

    // Fill the Top 100 with real users when period activity is still sparse.
    if (leaderboardUsers.length < limitNum) {
      const existingIds = new Set(leaderboardUsers.map((user) => user.userId));
      const topConnectorUserWhere: any = { isBanned: false };
      if (existingIds.size > 0) {
        topConnectorUserWhere.id = { notIn: Array.from(existingIds) };
      }

      const topConnectors = await prisma.userStats.findMany({
        where: {
          connectionsCount: { gt: 0 },
          user: { is: topConnectorUserWhere },
        },
        orderBy: { connectionsCount: 'desc' },
        take: limitNum - leaderboardUsers.length,
        include: {
          user: {
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

      topConnectors.forEach((stats) => {
        existingIds.add(stats.user.id);
        leaderboardUsers.push({
          rank: leaderboardUsers.length + 1,
          userId: stats.user.id,
          username: stats.user.username,
          name: stats.user.name || 'Vormex User',
          profileImage: stats.user.profileImage,
          headline: stats.user.headline || null,
          score: stats.connectionsCount * 10,
          connectionsThisPeriod: 0,
          isCurrentUser: stats.user.id === userId,
        });
      });
    }

    if (leaderboardUsers.length < limitNum) {
      const existingIds = new Set(leaderboardUsers.map((user) => user.userId));
      const additionalUsersWhere: any = { isBanned: false };
      if (existingIds.size > 0) {
        additionalUsersWhere.id = { notIn: Array.from(existingIds) };
      }

      const additionalUsers = await prisma.user.findMany({
        where: additionalUsersWhere,
        orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
        take: limitNum - leaderboardUsers.length,
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          headline: true,
          userStats: {
            select: {
              connectionsCount: true,
            },
          },
        },
      });

      additionalUsers.forEach((user) => {
        const connectionsCount = user.userStats?.connectionsCount || 0;
        leaderboardUsers.push({
          rank: leaderboardUsers.length + 1,
          userId: user.id,
          username: user.username,
          name: user.name || 'Vormex User',
          profileImage: user.profileImage,
          headline: user.headline || null,
          score: connectionsCount * 10,
          connectionsThisPeriod: 0,
          isCurrentUser: user.id === userId,
        });
      });
    }

    let currentUserRank: number | null = null;
    if (userId) {
      const visibleCurrentUserIndex = leaderboardUsers.findIndex(u => u.userId === userId);
      if (visibleCurrentUserIndex >= 0) {
        currentUserRank = visibleCurrentUserIndex + 1;
      } else {
        const currentUserIndex = userScores.findIndex(s => s.userId === userId);
        if (currentUserIndex >= 0) {
          currentUserRank = currentUserIndex + 1;
        }
      }
    }

    const response = {
      data: {
        users: leaderboardUsers,
        period,
        currentUserRank,
        totalParticipants: Math.max(userScores.length, leaderboardUsers.length),
      },
    };
    await cacheService.set(cacheKey, response, TOP_NETWORKERS_CACHE_TTL_SECONDS, [TOP_NETWORKERS_CACHE_TAG]);
    res.setHeader('X-Cache', 'MISS');
    res.json(response);
  } catch (error) {
    console.error('getLeaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};
