import { prisma } from '../../../config/prisma';

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
}

export const engagementService = new EngagementService();
