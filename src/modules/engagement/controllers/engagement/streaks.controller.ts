import { Response } from "express";
import { updateEngagementStreak } from "../../services/streak.service";
import { recordActivity } from "../../services/activity.service";
import { getIO } from "../../../../realtime/socket-registry";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { spendCoins } from "../../services/progress.service";
import { AuthRequest } from "./support.controller";
import { buildStreakResponseData } from "./snapshot-support.controller";

// ======================
// STREAKS
// ======================
export const getStreaks = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({
      data: await buildStreakResponseData(userId),
    });
  } catch (error) {
    console.error('getStreaks error:', error);
    res.status(500).json({ error: 'Failed to fetch streaks' });
  }
};

// ======================
// RECORD LOGIN
// ======================
export const recordLogin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await updateEngagementStreak(userId, 'login');
    await recordActivity(userId, 'login', 1);

    // Emit Socket.IO event for streak update
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('streak:updated', { type: 'login' });
    }

    res.status(200).json({
      message: 'Login recorded',
      data: await buildStreakResponseData(userId),
    });
  } catch (error) {
    console.error('recordLogin error:', error);
    res.status(500).json({ error: 'Failed to record login' });
  }
};

// ======================
// STREAK HISTORY
// ======================
export const getStreakHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = parseInt(req.query.limit as string) || 30;

    // Get activity records for streak history
    const activities = await prisma.userDailyActivity.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: limit,
    });

    const history = activities.map((activity, i) => ({
      id: activity.id,
      date: activity.date.toISOString().split('T')[0],
      type: activity.postsCount > 0 ? 'posting' : activity.messagesCount > 0 ? 'messaging' : 'login',
      streakCount: activities.length - i, // Approximate
      xpEarned: (activity.postsCount * 10) + (activity.commentsCount * 2) + (activity.messagesCount * 1),
      wasAtRisk: false, // TODO: Track this separately
      usedFreeze: false, // TODO: Track this separately
    }));

    res.json(history);
  } catch (error) {
    console.error('getStreakHistory error:', error);
    res.status(500).json({ error: 'Failed to fetch streak history' });
  }
};

// ======================
// PUBLIC STREAKS
// ======================
export const getPublicStreaks = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const streak = await prisma.engagement_streaks.findUnique({
      where: { userId },
    });

    res.json({
      data: {
        connectionStreak: streak?.connectionStreak || 0,
        loginStreak: streak?.loginStreak || 0,
        showOnProfile: true, // TODO: Add to EngagementStreak model
      },
    });
  } catch (error) {
    console.error('getPublicStreaks error:', error);
    res.status(500).json({ error: 'Failed to fetch public streaks' });
  }
};

// ======================
// PURCHASE STREAK FREEZE
// ======================
export const purchaseStreakFreeze = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const COIN_COST = 100;
    const requestKey = String(req.get('Idempotency-Key') || '').trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestKey)) {
      res.status(400).json({
        error: 'A valid Idempotency-Key header is required.',
        code: 'idempotency_key_required',
      });
      return;
    }

    const streak = await prisma.engagement_streaks.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    const { newBalance } = await spendCoins({
      userId,
      amount: COIN_COST,
      type: 'streak_freeze_purchase',
      source: 'streaks',
      sourceId: streak.id,
      description: 'Purchased streak freeze',
      idempotencyKey: `${userId}:streak_freeze:${requestKey}`,
      onSpend: async (tx) => {
        await tx.engagement_streaks.update({
          where: { userId },
          data: { streakFreezes: { increment: 1 } },
        });
      },
    });

    const updatedStreak = await prisma.engagement_streaks.findUnique({
      where: { userId },
      select: { streakFreezes: true },
    });

    res.json({
      data: {
        success: true,
        streakFreezes: updatedStreak?.streakFreezes || streak.streakFreezes,
        coinCost: COIN_COST,
        coinsBalance: newBalance,
        xpCost: COIN_COST,
        xpBalance: newBalance,
        message: 'Streak freeze purchased!',
      },
    });
  } catch (error) {
    console.error('purchaseStreakFreeze error:', error);
    if (error instanceof Error && error.message === 'Not enough Coins') {
      res.status(400).json({ error: 'Not enough Coins' });
      return;
    }
    res.status(500).json({ error: 'Failed to purchase streak freeze' });
  }
};

// ======================
// TOGGLE STREAK SHIELD
// ======================
export const toggleStreakShield = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const streak = await prisma.engagement_streaks.findUnique({
      where: { userId },
    });

    if (!streak) {
      res.status(400).json({ error: 'Streak data not found' });
      return;
    }

    // Check if user has freezes available
    if (!streak.streakShieldActive && streak.streakFreezes <= 0) {
      res.status(400).json({ error: 'No streak freezes available' });
      return;
    }

    const newShieldState = !streak.streakShieldActive;

    await prisma.engagement_streaks.update({
      where: { userId },
      data: { streakShieldActive: newShieldState },
    });

    res.json({
      data: {
        streakShieldActive: newShieldState,
        message: newShieldState ? 'Streak shield activated!' : 'Streak shield deactivated!',
      },
    });
  } catch (error) {
    console.error('toggleStreakShield error:', error);
    res.status(500).json({ error: 'Failed to toggle streak shield' });
  }
};

// ======================
// STREAK LEADERBOARD
// ======================
export const getStreakLeaderboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { type = 'login', limit = 10 } = req.query;
    const limitNum = Math.min(parseInt(limit as string) || 10, 50);

    const streakField = type === 'connection' ? 'connectionStreak' :
                        type === 'posting' ? 'postingStreak' :
                        type === 'messaging' ? 'messagingStreak' : 'loginStreak';
    const longestField = type === 'connection' ? 'longestConnectionStreak' :
                         type === 'posting' ? 'longestPostingStreak' :
                         type === 'messaging' ? 'longestMessagingStreak' : 'longestLoginStreak';

    const topStreaks = await prisma.engagement_streaks.findMany({
      where: {
        [streakField]: { gt: 0 },
      },
      orderBy: { [streakField]: 'desc' },
      take: limitNum,
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            college: true,
            bio: true,
          },
        },
      },
    });

    // Find current user's rank
    let myRank: number | null = null;
    if (userId) {
      const userStreak = await prisma.engagement_streaks.findUnique({
        where: { userId },
      });

      if (userStreak) {
        const userStreakValue = (userStreak as any)[streakField] || 0;
        myRank = await prisma.engagement_streaks.count({
          where: {
            [streakField]: { gt: userStreakValue },
          },
        }) + 1;
      }
    }

    res.json({
      data: {
        type,
        leaderboard: topStreaks.map((s, i) => ({
          rank: i + 1,
          user: {
            id: s.users.id,
            username: s.users.username,
            name: s.users.name,
            profileImage: s.users.profileImage,
            college: s.users.college ?? null,
            bio: s.users.bio ?? null,
          },
          currentStreak: (s as any)[streakField],
          longestStreak: (s as any)[longestField] ?? (s as any)[streakField],
        })),
        myRank,
      },
    });
  } catch (error) {
    console.error('getStreakLeaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch streak leaderboard' });
  }
};

// ======================
// TOGGLE STREAK VISIBILITY
// ======================
export const toggleStreakVisibility = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // TODO: Add showOnProfile field to EngagementStreak model
    // For now, just return success
    res.json({
      data: {
        showOnProfile: true,
        message: 'Streak visibility updated!',
      },
    });
  } catch (error) {
    console.error('toggleStreakVisibility error:', error);
    res.status(500).json({ error: 'Failed to toggle streak visibility' });
  }
};
