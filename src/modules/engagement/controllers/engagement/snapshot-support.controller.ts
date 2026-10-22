import { prisma } from "../../../../config/prisma";
import { calculateDailyActivityStreak } from "../../services/progress.service";
import { getWeekStart, checkAtRisk } from "./support.controller";

export // v3: the match payload now forwards `interests`. Bumped so cached v2 snapshots
// (which omit the field, TTL 48h) are not served for another two days.
const DAILY_MATCH_CACHE_VERSION = 'v3';

export const DAILY_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DAILY_MATCH_CACHE_TTL_SECONDS = 48 * 60 * 60;

export function dailyMatchSnapshotWindow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / DAILY_MATCH_WINDOW_MS);
}

export async function buildStreakResponseData(userId: string) {
  let streak = await prisma.engagement_streaks.findUnique({
    where: { userId },
  });

  if (!streak) {
    streak = await prisma.engagement_streaks.create({
      data: { userId },
    });
  }

  const [userStats, dailyStreak, weeklyConnections] = await Promise.all([
    prisma.userStats.findUnique({ where: { userId } }),
    calculateDailyActivityStreak(userId),
    prisma.connections.count({
      where: {
        status: 'accepted',
        updatedAt: { gte: getWeekStart() },
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
    }),
  ]);

  const isAtRisk = {
    daily: dailyStreak.isAtRisk,
    connection: checkAtRisk(streak.lastConnectionDate, streak.connectionStreak),
    login: checkAtRisk(streak.lastLoginDate, streak.loginStreak),
    posting: checkAtRisk(streak.lastPostDate, streak.postingStreak),
    messaging: checkAtRisk(streak.lastMessageDate, streak.messagingStreak),
  };

  const overallBestStreak = Math.max(
    streak.longestConnectionStreak || streak.bestConnectionStreak || 0,
    streak.longestLoginStreak || streak.bestLoginStreak || 0,
    streak.longestPostingStreak || streak.bestPostingStreak || 0,
    streak.longestMessagingStreak || streak.bestMessagingStreak || 0,
    dailyStreak.longest
  );

  const engagementScore = Math.min(100, Math.round(
    (dailyStreak.current * 12 +
     streak.connectionStreak * 10 +
     streak.loginStreak * 3 +
     streak.postingStreak * 15 +
     streak.messagingStreak * 8 +
     (userStats?.xp || 0) / 10) / 5
  ));

  return {
    dailyStreak: dailyStreak.current,
    longestDailyStreak: dailyStreak.longest,
    dailyQualifiedToday: dailyStreak.qualifiedToday,
    dailyIsAtRisk: dailyStreak.isAtRisk,
    dailyLastQualifiedDate: dailyStreak.lastQualifiedDate?.toISOString().split('T')[0] || null,
    connectionStreak: streak.connectionStreak,
    longestConnectionStreak: streak.longestConnectionStreak || streak.bestConnectionStreak || streak.connectionStreak,
    loginStreak: streak.loginStreak,
    longestLoginStreak: streak.longestLoginStreak || streak.bestLoginStreak || streak.loginStreak,
    postingStreak: streak.postingStreak,
    longestPostingStreak: streak.longestPostingStreak || streak.bestPostingStreak || streak.postingStreak,
    messagingStreak: streak.messagingStreak,
    longestMessagingStreak: streak.longestMessagingStreak || streak.bestMessagingStreak || streak.messagingStreak,
    overallBestStreak,
    weeklyConnectionsMade: weeklyConnections,
    weeklyConnectionsGoal: 10,
    streakFreezes: streak.streakFreezes,
    streakShieldActive: streak.streakShieldActive,
    totalFreezesUsed: Math.max(0, 3 - streak.streakFreezes),
    isAtRisk,
    engagementScore,
    showOnProfile: true,
  };
}
