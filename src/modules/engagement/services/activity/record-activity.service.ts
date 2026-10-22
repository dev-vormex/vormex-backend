import { prisma } from "../../../../config/prisma";
import type { ActivityType } from "../../types/activity.types";
import { awardActivityProgress, isMeaningfulActivity } from "../progress.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { updateUserStats } from "./calculate-streak.service";

export const ACTIVITY_HEATMAP_CACHE_TTL_SECONDS = 120;

export const ACTIVITY_YEARS_CACHE_TTL_SECONDS = 24 * 60 * 60;

export const activityCacheTags = (userId: string) => [`user:${userId}`, `activity:${userId}`];

/**
 * Get today's date in UTC as YYYY-MM-DD string
 */
function getTodayDateString(): string {
  const today = new Date();
  return today.toISOString().split('T')[0];
}

/**
 * Record user activity for today
 * Fire and forget - doesn't block main operation
 * 
 * @param userId - User ID
 * @param activityType - Type of activity performed
 * @param count - Number of activities (default: 1)
 */
export async function recordActivity(
  userId: string,
  activityType: ActivityType,
  count: number = 1,
  options: { sourceId?: string | null; skipStatsUpdate?: boolean } = {}
): Promise<void> {
  try {
    const today = getTodayDateString();
    const todayDate = new Date(today + 'T00:00:00.000Z');
    const activityCount = Math.max(0, Math.floor(count || 0));
    const countsForDailyStreak = activityCount > 0 && isMeaningfulActivity(activityType);

    const existingActivity = await prisma.userDailyActivity.findUnique({
      where: {
        userId_date: {
          userId,
          date: todayDate,
        },
      },
    });

    // Prepare update data based on activity type
    const updateData: any = {};

    if (countsForDailyStreak) {
      updateData.isActive = true;
    }

    switch (activityType) {
      case 'post':
        updateData.postsCount = { increment: activityCount };
        break;
      case 'article':
        updateData.articlesCount = { increment: activityCount };
        break;
      case 'comment':
        updateData.commentsCount = { increment: activityCount };
        break;
      case 'forum_question':
        updateData.forumQuestionsCount = { increment: activityCount };
        break;
      case 'forum_answer':
        updateData.forumAnswersCount = { increment: activityCount };
        break;
      case 'like':
        updateData.likesGivenCount = { increment: activityCount };
        break;
      case 'message':
        updateData.messagesCount = { increment: activityCount };
        break;
      case 'short_video':
        updateData.postsCount = { increment: activityCount };
        break;
      case 'connection':
        // Connections mark the day as active but don't increment a counter
        // The connection count is tracked in UserStats.connectionsCount
        break;
      case 'login':
        // Logins are tracked as a category streak only; they do not preserve Daily Activity Streak.
        break;
      default:
        console.warn(`Unknown activity type: ${activityType}`);
        return;
    }

    // Upsert the activity record
    await prisma.userDailyActivity.upsert({
      where: {
        userId_date: {
          userId,
          date: todayDate,
        },
      },
      create: {
        userId,
        date: todayDate,
        postsCount: activityType === 'post' || activityType === 'short_video' ? activityCount : 0,
        articlesCount: activityType === 'article' ? activityCount : 0,
        commentsCount: activityType === 'comment' ? activityCount : 0,
        forumQuestionsCount: activityType === 'forum_question' ? activityCount : 0,
        forumAnswersCount: activityType === 'forum_answer' ? activityCount : 0,
        likesGivenCount: activityType === 'like' ? activityCount : 0,
        messagesCount: activityType === 'message' ? activityCount : 0,
        isActive: countsForDailyStreak,
      },
      update: Object.keys(updateData).length > 0
        ? updateData
        : { isActive: existingActivity?.isActive ?? false },
    });

    cacheService.invalidateTags(...activityCacheTags(userId)).catch((error: unknown) => {
      console.error(`Failed to invalidate activity cache for user ${userId}:`, error);
    });

    if (countsForDailyStreak) {
      await awardActivityProgress({
        userId,
        activityType,
        count: activityCount,
        sourceId: options.sourceId,
      });
    }

    console.log(`Activity recorded: user ${userId}, type: ${activityType}, count: ${activityCount}`);

    if (!options.skipStatsUpdate) {
      // Existing callers retain fire-and-forget aggregation. Background connection
      // processing skips it because it refreshes connection counts sequentially.
      updateUserStats(userId).catch((err) =>
        console.error(`Failed to update stats for user ${userId}:`, err)
      );
    }
  } catch (error) {
    console.error(`Failed to record activity for user ${userId}:`, error);
    // Don't throw - activity tracking is non-critical
  }
}
