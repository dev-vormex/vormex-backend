import { Response } from "express";
import { getConnectionRequestLimitState, getDailyUsageWindowStart } from "../../../safety/services/tier-limits.service";
import { getTodayStart } from "../../utils/streak-date.util";
import { prisma } from "../../../../config/prisma";
import { isPrismaConnectionError } from "../../../../shared/utils/prisma-error.util";
import { ensureString } from "../../../../shared/utils/request.util";
import { getProgressOverview } from "../../services/progress.service";
import { AuthRequest } from "./support.controller";
import { buildStreakResponseData } from "./snapshot-support.controller";
import { buildWeeklyGoalsData } from "./goals.controller";

// ======================
// CONNECTION LIMIT (Scarcity)
// ======================
export const getConnectionLimit = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limitState = await getConnectionRequestLimitState(userId);
    const resetsAt = limitState.windowStart
      ? new Date(getDailyUsageWindowStart(limitState.windowStart).getTime() + 24 * 60 * 60 * 1000)
      : null;

    res.json({
      data: {
        canSend: limitState.allowed,
        remaining: limitState.remaining ?? 0,
        limit: limitState.limit ?? 0,
        used: limitState.used,
        isPremium: limitState.isPremium,
        unlimitedRequests: limitState.limit === null,
        window: 'day',
        resetsAt: resetsAt?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error('getConnectionLimit error:', error);
    res.status(500).json({ error: 'Failed to fetch connection limit' });
  }
};

// ======================
// SESSION SUMMARY (Peak-End Rule)
// ======================
export const getSessionSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const todayStart = getTodayStart();

    // Get today's activity
    const todayActivity = await prisma.userDailyActivity.findUnique({
      where: {
        userId_date: {
          userId,
          date: todayStart,
        },
      },
    });

    // Count connections accepted today
    const connectionsAccepted = await prisma.connections.count({
      where: {
        status: 'accepted',
        updatedAt: { gte: todayStart },
        addresseeId: userId, // Connections they accepted
      },
    });

    // Count new posts today
    const newPosts = todayActivity?.postsCount || 0;

    // Count messages sent today
    const messagesCount = todayActivity?.messagesCount || 0;

    // Generate appropriate message based on activity
    let message = 'Great session!';
    let emoji = '👋';

    const totalActivity = connectionsAccepted + newPosts + messagesCount;

    if (totalActivity === 0) {
      message = 'See you next time!';
      emoji = '👋';
    } else if (totalActivity >= 10) {
      message = 'Amazing networking today!';
      emoji = '🚀';
    } else if (connectionsAccepted > 0) {
      message = 'Great connections made!';
      emoji = '🤝';
    } else if (newPosts > 0) {
      message = 'Nice content shared!';
      emoji = '✍️';
    } else if (messagesCount > 0) {
      message = 'Good conversations!';
      emoji = '💬';
    }

    res.json({
      data: {
        connectionsAccepted,
        newPosts,
        messagesCount,
        message,
        emoji,
      },
    });
  } catch (error) {
    console.error('getSessionSummary error:', error);
    if (isPrismaConnectionError(error)) {
      res.status(503).json({ error: 'Database is temporarily unavailable. Please try again in a moment.' });
      return;
    }
    res.status(500).json({ error: 'Failed to fetch session summary' });
  }
};

// ======================
// CONNECTION CELEBRATION
// ======================
export const getConnectionCelebration = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const connectionId = ensureString(req.params.connectionId);

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!connectionId) {
      res.status(400).json({ error: 'Connection ID is required' });
      return;
    }

    // Get the connection with both users
    const connection = await prisma.connections.findUnique({
      where: { id: connectionId },
      include: {
        users_connections_requesterIdTousers: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
          },
        },
        users_connections_addresseeIdTousers: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
          },
        },
      },
    });

    if (!connection || connection.status !== 'accepted') {
      res.json({ data: null });
      return;
    }

    // Determine the other user
    const connWithRelations = connection as typeof connection & { users_connections_requesterIdTousers: { id: string; name: string; profileImage: string | null; username: string }; users_connections_addresseeIdTousers: { id: string; name: string; profileImage: string | null; username: string } };
    const otherUser = connection.requesterId === userId ? connWithRelations.users_connections_addresseeIdTousers : connWithRelations.users_connections_requesterIdTousers;

    // Count mutual connections
    const userConnections = await prisma.connections.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const otherUserConnections = await prisma.connections.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: otherUser.id },
          { addresseeId: otherUser.id },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const userConnIds = new Set<string>();
    userConnections.forEach((c) => {
      userConnIds.add(c.requesterId === userId ? c.addresseeId : c.requesterId);
    });

    let mutualConnections = 0;
    otherUserConnections.forEach((c) => {
      const otherId = c.requesterId === otherUser.id ? c.addresseeId : c.requesterId;
      if (userConnIds.has(otherId)) mutualConnections++;
    });

    // Get user's streak
    const streak = await prisma.engagement_streaks.findUnique({
      where: { userId },
    });

    const showConfetti = (streak?.connectionStreak || 0) > 0;

    // Generate celebration message
    const messages = [
      `You're now connected with ${otherUser.name}!`,
      `Great connection! ${otherUser.name} is in your network now.`,
      `Welcome ${otherUser.name} to your professional network!`,
    ];

    res.json({
      data: {
        otherUser: {
          name: otherUser.name,
          profileImage: otherUser.profileImage,
          username: otherUser.username,
        },
        mutualConnections,
        celebrationMessage: messages[Math.floor(Math.random() * messages.length)],
        showConfetti,
      },
    });
  } catch (error) {
    console.error('getConnectionCelebration error:', error);
    res.status(500).json({ error: 'Failed to fetch celebration' });
  }
};

// ======================
// DASHBOARD
// ======================
export const getDashboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [progress, streaks, weeklyGoals, userStats] = await Promise.all([
      getProgressOverview(userId),
      buildStreakResponseData(userId),
      buildWeeklyGoalsData(userId),
      prisma.userStats.findUnique({ where: { userId } }),
    ]);

    // Calculate rank
    const rank = await prisma.userStats.count({
      where: {
        connectionsCount: { gt: userStats?.connectionsCount || 0 },
      },
    }) + 1;

    res.json({
      data: {
        streaks,
        weeklyGoals,
        progress,
        xpEarned: progress.xp.lifetimeXp,
        level: progress.xp.level,
        coinsBalance: progress.coins.balance,
        rank,
      },
    });
  } catch (error) {
    console.error('getDashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
};
