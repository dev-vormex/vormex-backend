import { prisma } from "../../../../config/prisma";
import { calculateDailyActivityStreak } from "../../services/progress.service";
import { Response } from "express";
import { isToday, getTodayStart } from "../../utils/streak-date.util";
import { getWeekStart, AuthRequest } from "./support.controller";

export async function buildWeeklyGoalsData(userId: string) {
  const weekStart = getWeekStart();
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);

  const [connectionsMade, postsMade, weeklyActivity, dailyStreak] = await Promise.all([
    prisma.connections.count({
      where: {
        status: 'accepted',
        updatedAt: { gte: weekStart, lte: weekEnd },
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
    }),
    prisma.post.count({
      where: {
        authorId: userId,
        createdAt: { gte: weekStart, lte: weekEnd },
      },
    }),
    prisma.userDailyActivity.aggregate({
      where: {
        userId,
        date: { gte: weekStart, lte: weekEnd },
      },
      _sum: {
        messagesCount: true,
      },
    }),
    calculateDailyActivityStreak(userId),
  ]);

  const messagesSent = weeklyActivity._sum.messagesCount || 0;
  const goals = [
    {
      id: 'weekly-connections',
      type: 'connections',
      label: 'Connections',
      current: connectionsMade,
      target: 10,
      isComplete: connectionsMade >= 10,
    },
    {
      id: 'weekly-posts',
      type: 'posts',
      label: 'Posts',
      current: postsMade,
      target: 3,
      isComplete: postsMade >= 3,
    },
    {
      id: 'weekly-messages',
      type: 'messages',
      label: 'Messages',
      current: messagesSent,
      target: 20,
      isComplete: messagesSent >= 20,
    },
  ];

  const totalProgress =
    goals.reduce((sum, goal) => sum + Math.min(1, goal.current / goal.target), 0) / goals.length;
  const nextGoal = goals.find((goal) => !goal.isComplete);
  const reminderMessage = nextGoal
    ? `${Math.max(0, nextGoal.target - nextGoal.current)} more ${nextGoal.label.toLowerCase()} to finish this week.`
    : 'All weekly goals are complete.';

  return {
    id: `weekly-${weekStart.toISOString().split('T')[0]}`,
    weekStartDate: weekStart.toISOString(),
    weekEndDate: weekEnd.toISOString(),
    goals,
    totalProgress,
    streakAtRisk: dailyStreak.isAtRisk,
    reminderMessage,
    // Backward-compatible fields for older Android builds.
    weekStart: weekStart.toISOString(),
    connectionsTarget: 10,
    postsTarget: 3,
    messagesTarget: 20,
    connectionsMade,
    postsMade,
    messagesSent,
    isCompleted: goals.every((goal) => goal.isComplete),
    xpEarned: goals.every((goal) => goal.isComplete) ? 100 : 0,
    connectionsProgress: Math.min(100, Math.round((connectionsMade / 10) * 100)),
    postsProgress: Math.min(100, Math.round((postsMade / 3) * 100)),
    messagesProgress: Math.min(100, Math.round((messagesSent / 20) * 100)),
  };
}

// ======================
// NUDGES (Zeigarnik Effect)
// ======================
export const getNudges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const nudges: Array<{
      type: string;
      message: string;
      progress: number;
      target: number;
      icon: string;
    }> = [];

    // Get user stats
    const userStats = await prisma.userStats.findUnique({
      where: { userId },
    });

    // Get profile views
    const profileViews = await prisma.profile_views.count({
      where: {
        viewedId: userId,
        viewedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });

    // Get user profile completeness
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        headline: true,
        bio: true,
        profileImage: true,
        college: true,
        interests: true,
      },
    });

    // Profile view nudge
    if (profileViews > 0) {
      const hasCompleteProfile = user?.headline && user?.bio && user?.profileImage;
      if (!hasCompleteProfile) {
        nudges.push({
          type: 'profile_views',
          message: `${profileViews} people viewed your profile. Complete it to get more connections!`,
          progress: profileViews,
          target: 10,
          icon: '👀',
        });
      }
    }

    // Weekly connections nudge
    const weekStart = getWeekStart();
    const weeklyConnections = await prisma.connections.count({
      where: {
        status: 'accepted',
        updatedAt: { gte: weekStart },
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
    });

    if (weeklyConnections < 10) {
      nudges.push({
        type: 'weekly_connections',
        message: `You're ${weeklyConnections}/10 on weekly connections. ${10 - weeklyConnections} more to go!`,
        progress: weeklyConnections,
        target: 10,
        icon: '🤝',
      });
    }

    // Streak at risk nudge
    const streak = await prisma.engagement_streaks.findUnique({
      where: { userId },
    });

    if (streak && streak.connectionStreak > 0 && !isToday(streak.lastConnectionDate)) {
      nudges.push({
        type: 'streak_at_risk',
        message: `Your ${streak.connectionStreak}-day networking streak is at risk! Connect with someone today.`,
        progress: 0,
        target: 1,
        icon: '🔥',
      });
    }

    // Post engagement nudge
    const todayStart = getTodayStart();
    const todayPosts = await prisma.post.count({
      where: {
        authorId: userId,
        createdAt: { gte: todayStart },
      },
    });

    if (todayPosts === 0 && (userStats?.totalPosts || 0) > 0) {
      nudges.push({
        type: 'daily_post',
        message: "You haven't posted today. Share something with your network!",
        progress: 0,
        target: 1,
        icon: '✍️',
      });
    }

    res.json({ data: nudges });
  } catch (error) {
    console.error('getNudges error:', error);
    res.status(500).json({ error: 'Failed to fetch nudges' });
  }
};

// ======================
// WEEKLY GOALS (Progress)
// ======================
export const getWeeklyGoals = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({
      data: await buildWeeklyGoalsData(userId),
    });
  } catch (error) {
    console.error('getWeeklyGoals error:', error);
    res.status(500).json({ error: 'Failed to fetch weekly goals' });
  }
};
