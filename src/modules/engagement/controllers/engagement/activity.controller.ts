import { Response } from "express";
import { getTodayStart } from "../../utils/streak-date.util";
import { prisma } from "../../../../config/prisma";
import { AuthRequest } from "./support.controller";

// ======================
// TRENDING STATUS (Variable Reward)
// ======================
export const getTrendingStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Variable reward logic: randomly feature some users
    // In production, this could be based on:
    // - High engagement rate
    // - Recent connections
    // - Profile completeness
    // - Activity level
    const random = Math.random();
    
    // ~10% chance to be "trending" - creates excitement
    const isTrending = random < 0.1;
    
    if (!isTrending) {
      res.json({
        data: {
          isTrending: false,
          rank: null,
          viewsToday: Math.floor(Math.random() * 5), // Small number when not trending
          message: null,
        },
      });
      return;
    }

    // User is trending today! Generate exciting metrics
    const viewsToday = Math.floor(Math.random() * 50) + 10; // 10-60 views
    const rank = Math.floor(Math.random() * 20) + 1; // Top 1-20

    const messages = [
      "Your profile is getting noticed!",
      "People are interested in connecting with you!",
      "You're making waves in the community!",
      "Your expertise is in demand!",
      "Great networking day ahead!",
    ];
    const message = messages[Math.floor(Math.random() * messages.length)];

    res.json({
      data: {
        isTrending: true,
        rank,
        viewsToday,
        message,
      },
    });
  } catch (error) {
    console.error('getTrendingStatus error:', error);
    res.status(500).json({ error: 'Failed to fetch trending status' });
  }
};

// ======================
// LIVE ACTIVITY (Social Proof)
// ======================
export const getLiveActivity = async (req: AuthRequest, res: Response): Promise<void> => {
  const countOrZero = async (label: string, count: () => Promise<number>): Promise<number> => {
    try {
      return await count();
    } catch (error) {
      console.warn(`getLiveActivity ${label} count failed:`, error);
      return 0;
    }
  };

  try {
    const { location } = req.query;
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const todayStart = getTodayStart();
    const locationLabel = Array.isArray(location)
      ? location[0]
      : typeof location === 'string' && location.trim()
        ? location.trim()
        : 'Worldwide';

    const [activeUsersNow, connectionsToday, newUsersToday] = await Promise.all([
      countOrZero('active users', () =>
        prisma.user.count({
          where: {
            lastActiveAt: { gte: fifteenMinsAgo },
            isBanned: false,
          },
        })
      ),
      countOrZero('connections today', () =>
        prisma.connections.count({
          where: {
            status: 'accepted',
            updatedAt: { gte: todayStart },
          },
        })
      ),
      countOrZero('new users today', () =>
        prisma.user.count({
          where: {
            createdAt: { gte: todayStart },
          },
        })
      ),
    ]);

    res.json({
      data: {
        activeUsersNow,
        connectionsToday,
        newUsersToday,
        locationLabel,
      },
    });
  } catch (error) {
    console.error('getLiveActivity error:', error);
    res.json({
      data: {
        activeUsersNow: 0,
        connectionsToday: 0,
        newUsersToday: 0,
        locationLabel: 'Worldwide',
      },
    });
  }
};

// ======================
// RECENT JOINS
// ======================
export const getRecentJoins = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Count new users this week
    const count = await prisma.user.count({
      where: {
        createdAt: { gte: weekAgo },
      },
    });

    res.json({
      count,
      label: 'new members this week',
    });
  } catch (error) {
    console.error('getRecentJoins error:', error);
    res.status(500).json({ error: 'Failed to fetch recent joins' });
  }
};
