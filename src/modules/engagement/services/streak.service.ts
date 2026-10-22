import { prisma } from '../../../config/prisma';
import { getIO } from '../../../realtime/socket-registry';
import { getTodayStart, isToday } from '../utils/streak-date.util';

export async function updateEngagementStreak(
  userId: string,
  streakType: 'connection' | 'login' | 'posting' | 'messaging'
): Promise<void> {
  try {
    const today = getTodayStart();
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    let streak = await prisma.engagement_streaks.findUnique({
      where: { userId },
    });

    if (!streak) {
      streak = await prisma.engagement_streaks.create({
        data: { userId },
      });
    }

    const fieldMap = {
      connection: {
        streak: 'connectionStreak',
        lastDate: 'lastConnectionDate',
        longest: 'longestConnectionStreak',
        best: 'bestConnectionStreak',
      },
      login: {
        streak: 'loginStreak',
        lastDate: 'lastLoginDate',
        longest: 'longestLoginStreak',
        best: 'bestLoginStreak',
      },
      posting: {
        streak: 'postingStreak',
        lastDate: 'lastPostDate',
        longest: 'longestPostingStreak',
        best: 'bestPostingStreak',
      },
      messaging: {
        streak: 'messagingStreak',
        lastDate: 'lastMessageDate',
        longest: 'longestMessagingStreak',
        best: 'bestMessagingStreak',
      },
    };

    const fields = fieldMap[streakType];
    const currentStreak = (streak as any)[fields.streak] as number;
    const lastDate = (streak as any)[fields.lastDate] as Date | null;

    // Check if already updated today
    if (lastDate && isToday(lastDate)) {
      return;
    }

    // Calculate new streak
    let newStreak = 1;
    if (lastDate) {
      const lastDateNorm = new Date(lastDate);
      lastDateNorm.setUTCHours(0, 0, 0, 0);
      if (lastDateNorm.getTime() === yesterday.getTime()) {
        newStreak = currentStreak + 1;
      }
    }

    const currentLongest = (streak as any)[fields.longest] || 0;
    const newLongest = Math.max(currentLongest, newStreak);

    await prisma.engagement_streaks.update({
      where: { userId },
      data: {
        [fields.streak]: newStreak,
        [fields.lastDate]: today,
        [fields.longest]: newLongest,
        [fields.best]: newLongest,
      },
    });

    // Emit Socket.IO event
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('streak:updated', {
        type: streakType,
        newStreak,
        isNewRecord: newStreak > currentLongest,
      });
    }

    console.log(`Updated ${streakType} streak for user ${userId}: ${newStreak}`);
  } catch (error) {
    console.error(`Failed to update ${streakType} streak for user ${userId}:`, error);
  }
}
