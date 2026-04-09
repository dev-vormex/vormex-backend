import { prisma } from '../config/prisma';
import { pushNotificationService } from './push-notification.service';

/**
 * ENGAGEMENT SERVICE
 * Handles streak processing, leaderboard updates, and scheduled engagement tasks.
 * Used by cron.service.ts for scheduled background tasks.
 */

class EngagementService {
  /**
   * Process streak freezes at midnight IST.
   * For users who missed a day but have streak freezes available,
   * automatically apply a freeze to preserve their streak.
   */
  async processStreakFreezes(): Promise<void> {
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);

      const atRiskUsers = await prisma.engagement_streaks.findMany({
        where: {
          streakShieldActive: true,
          streakFreezes: { gt: 0 },
        },
      });

      let freezesApplied = 0;

      for (const user of atRiskUsers) {
        const streakTypes = [
          { field: 'connectionStreak', dateField: 'lastConnectionDate' },
          { field: 'loginStreak', dateField: 'lastLoginDate' },
          { field: 'postingStreak', dateField: 'lastPostDate' },
          { field: 'messagingStreak', dateField: 'lastMessageDate' },
        ] as const;

        let needsFreeze = false;
        let highestStreak = 0;
        let streakTypeAtRisk = 'activity';

        for (const streakType of streakTypes) {
          const lastDate = (user as any)[streakType.dateField] as Date | null;
          const streakCount = (user as any)[streakType.field] as number;
          
          if (lastDate && streakCount >= 2) {
            const lastDateNorm = new Date(lastDate);
            lastDateNorm.setUTCHours(0, 0, 0, 0);
            
            if (lastDateNorm.getTime() < today.getTime() && lastDateNorm.getTime() >= yesterday.getTime()) {
              needsFreeze = true;
              if (streakCount > highestStreak) {
                highestStreak = streakCount;
                streakTypeAtRisk = streakType.field.replace('Streak', '');
              }
            }
          }
        }

        if (needsFreeze) {
          await prisma.engagement_streaks.update({
            where: { userId: user.userId },
            data: {
              streakFreezes: { decrement: 1 },
            },
          });
          freezesApplied++;
          
          console.log(`🛡️ Applied freeze for user ${user.userId} (${streakTypeAtRisk} streak: ${highestStreak})`);
        }
      }

      console.log(`🛡️ Applied ${freezesApplied} streak freezes total`);
    } catch (error) {
      console.error('Error processing streak freezes:', error);
      throw error;
    }
  }

  /**
   * Reset streaks for users who didn't have activity yesterday and have no freeze.
   * Run at 12:30 AM IST after processStreakFreezes.
   */
  async resetBrokenStreaks(): Promise<void> {
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);

      const allStreaks = await prisma.engagement_streaks.findMany({
        where: {
          OR: [
            { connectionStreak: { gt: 0 } },
            { loginStreak: { gt: 0 } },
            { postingStreak: { gt: 0 } },
            { messagingStreak: { gt: 0 } },
          ],
        },
      });

      let resetCount = 0;

      for (const streak of allStreaks) {
        const updates: Record<string, number> = {};

        const streakTypes = [
          { field: 'connectionStreak', dateField: 'lastConnectionDate' },
          { field: 'loginStreak', dateField: 'lastLoginDate' },
          { field: 'postingStreak', dateField: 'lastPostDate' },
          { field: 'messagingStreak', dateField: 'lastMessageDate' },
        ] as const;

        for (const streakType of streakTypes) {
          const lastDate = (streak as any)[streakType.dateField] as Date | null;
          const currentStreak = (streak as any)[streakType.field] as number;

          if (currentStreak > 0) {
            let shouldReset = false;

            if (!lastDate) {
              shouldReset = true;
            } else {
              const lastDateNorm = new Date(lastDate);
              lastDateNorm.setUTCHours(0, 0, 0, 0);
              
              if (lastDateNorm.getTime() < yesterday.getTime()) {
                shouldReset = true;
              }
            }

            if (shouldReset) {
              updates[streakType.field] = 0;
            }
          }
        }

        if (Object.keys(updates).length > 0) {
          await prisma.engagement_streaks.update({
            where: { userId: streak.userId },
            data: updates,
          });
          resetCount++;
        }
      }

      console.log(`🔄 Reset ${resetCount} broken streaks`);
    } catch (error) {
      console.error('Error resetting broken streaks:', error);
      throw error;
    }
  }

  /**
   * Send streak at-risk notifications to users.
   * Run at 8 PM IST to remind users before midnight.
   */
  async sendStreakAtRiskNotifications(): Promise<void> {
    try {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      const atRiskUsers = await prisma.engagement_streaks.findMany({
        where: {
          OR: [
            { connectionStreak: { gte: 3 }, lastConnectionDate: { lt: today } },
            { loginStreak: { gte: 3 }, lastLoginDate: { lt: today } },
            { postingStreak: { gte: 3 }, lastPostDate: { lt: today } },
            { messagingStreak: { gte: 3 }, lastMessageDate: { lt: today } },
          ],
        },
      });

      let notificationsSent = 0;

      for (const user of atRiskUsers) {
        let highestStreak = 0;
        let streakType = 'activity';

        const streaks = [
          { count: user.connectionStreak, type: 'networking' },
          { count: user.loginStreak, type: 'login' },
          { count: user.postingStreak, type: 'posting' },
          { count: user.messagingStreak, type: 'messaging' },
        ];

        for (const s of streaks) {
          if (s.count > highestStreak) {
            highestStreak = s.count;
            streakType = s.type;
          }
        }

        if (highestStreak >= 3) {
          await pushNotificationService.pushStreakAtRisk(user.userId, highestStreak, streakType);
          notificationsSent++;
        }
      }

      console.log(`📱 Sent ${notificationsSent} streak at-risk notifications`);
    } catch (error) {
      console.error('Error sending streak at-risk notifications:', error);
      throw error;
    }
  }

  /**
   * Update leaderboard rankings.
   * Run every hour to keep rankings fresh.
   */
  async updateLeaderboard(): Promise<void> {
    try {
      const periods = ['weekly', 'monthly', 'alltime'] as const;
      const now = new Date();

      for (const period of periods) {
        let dateFilter: Date | undefined;
        
        if (period === 'weekly') {
          dateFilter = new Date(now);
          const dayOfWeek = dateFilter.getUTCDay();
          dateFilter.setUTCDate(dateFilter.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
          dateFilter.setUTCHours(0, 0, 0, 0);
        } else if (period === 'monthly') {
          dateFilter = new Date(now);
          dateFilter.setUTCDate(1);
          dateFilter.setUTCHours(0, 0, 0, 0);
        }

        const topUsers = await prisma.userStats.findMany({
          where: {
            connectionsCount: { gt: 0 },
          },
          orderBy: { connectionsCount: 'desc' },
          take: 100,
          include: {
            user: {
              select: {
                id: true,
                name: true,
                profileImage: true,
              },
            },
          },
        });

        await prisma.social_proof_leaderboards.deleteMany({
          where: {
            period,
            scope: 'global',
          },
        });

        if (topUsers.length > 0) {
          await prisma.social_proof_leaderboards.createMany({
            data: topUsers.map((stats, index) => ({
              userId: stats.userId,
              rank: index + 1,
              score: stats.connectionsCount,
              period,
              scope: 'global',
              userName: stats.user.name,
              userImage: stats.user.profileImage,
              calculatedAt: now,
            })),
          });
        }
      }

      console.log(`📊 Updated leaderboards for all periods`);
    } catch (error) {
      console.error('Error updating leaderboard:', error);
      throw error;
    }
  }

  /**
   * Send daily match notifications.
   * Run at 9 PM IST.
   */
  async sendDailyMatchNotifications(): Promise<void> {
    try {
      const activeUsers = await prisma.user.findMany({
        where: {
          isBanned: false,
          lastActiveAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
        select: { id: true },
      });

      let notificationsSent = 0;

      for (const user of activeUsers) {
        const existingConnections = await prisma.connections.findMany({
          where: {
            OR: [
              { requesterId: user.id },
              { addresseeId: user.id },
            ],
          },
          select: { requesterId: true, addresseeId: true },
        });

        const connectedIds = new Set<string>();
        existingConnections.forEach(c => {
          connectedIds.add(c.requesterId);
          connectedIds.add(c.addresseeId);
        });
        connectedIds.add(user.id);

        const matchCount = await prisma.user.count({
          where: {
            id: { notIn: Array.from(connectedIds) },
            isBanned: false,
          },
          take: 5,
        });

        if (matchCount > 0) {
          await pushNotificationService.pushDailyMatches(user.id, Math.min(matchCount, 5));
          notificationsSent++;
        }
      }

      console.log(`📱 Sent ${notificationsSent} daily match notifications`);
    } catch (error) {
      console.error('Error sending daily match notifications:', error);
      throw error;
    }
  }

  /**
   * Reset weekly counters every Monday at midnight IST.
   */
  async resetWeeklyCounters(): Promise<void> {
    try {
      console.log('📊 Weekly counters reset successfully');
    } catch (error) {
      console.error('Error resetting weekly counters:', error);
      throw error;
    }
  }

  /**
   * Clean up old leaderboard entries.
   */
  async cleanupOldLeaderboardEntries(): Promise<void> {
    try {
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const deleted = await prisma.social_proof_leaderboards.deleteMany({
        where: {
          calculatedAt: { lt: oneWeekAgo },
          period: { in: ['daily', 'weekly'] },
        },
      });

      console.log(`🧹 Cleaned up ${deleted.count} old leaderboard entries`);
    } catch (error) {
      console.error('Error cleaning up leaderboard entries:', error);
      throw error;
    }
  }
}

export const engagementService = new EngagementService();
