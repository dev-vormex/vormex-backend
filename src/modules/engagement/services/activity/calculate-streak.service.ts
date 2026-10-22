import { prisma } from "../../../../config/prisma";
import type { StreakInfo } from "../../types/activity.types";
import { calculateLevelProgress, getLifetimeXp } from "../progress.service";

/**
 * Calculate streak information for a user
 * Matches GitHub/LeetCode logic: consecutive days with any activity
 * 
 * @param userId - User ID
 * @returns StreakInfo with current streak, longest streak, last active date, and total active days
 */
export async function calculateStreak(userId: string): Promise<StreakInfo> {
  try {
    // Fetch all activity records ordered by date DESC
    const activities = await prisma.userDailyActivity.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
    });

    if (activities.length === 0) {
      return {
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: null,
        totalActiveDays: 0,
      };
    }

    // Filter to only active days
    const activeDays = activities.filter((a) => a.isActive);
    const totalActiveDays = activeDays.length;

    // Find last active date
    const lastActiveDate = activeDays.length > 0 ? activeDays[0].date : null;

    // Calculate current streak
    // Start from today or yesterday (handle case where today has no activity yet)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    let currentStreak = 0;
    let checkDate = new Date(today);

    // Check if today has activity, if not start from yesterday
    const todayActivity = activities.find(
      (a) => a.date.toISOString().split('T')[0] === todayStr && a.isActive
    );

    if (!todayActivity) {
      // Start checking from yesterday
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    }

    // Count consecutive active days going backwards
    while (true) {
      const dateStr = checkDate.toISOString().split('T')[0];
      const dayActivity = activities.find(
        (a) => a.date.toISOString().split('T')[0] === dateStr
      );

      if (dayActivity && dayActivity.isActive) {
        currentStreak++;
        checkDate.setUTCDate(checkDate.getUTCDate() - 1);
      } else {
        break; // Streak broken
      }
    }

    // Calculate longest streak from all historical data
    let longestStreak = 0;
    let tempStreak = 0;

    // Sort by date ASC for longest streak calculation
    const sortedActivities = [...activities].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    for (const activity of sortedActivities) {
      if (activity.isActive) {
        tempStreak++;
        longestStreak = Math.max(longestStreak, tempStreak);
      } else {
        tempStreak = 0; // Reset on inactive day
      }
    }

    const streakInfo: StreakInfo = {
      currentStreak,
      longestStreak,
      lastActiveDate,
      totalActiveDays,
    };

    console.log(
      `Streak calculated for user ${userId}: current ${currentStreak}, longest ${longestStreak}`
    );

    return streakInfo;
  } catch (error) {
    console.error(`Failed to calculate streak for user ${userId}:`, error);
    return {
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      totalActiveDays: 0,
    };
  }
}

/**
 * Update aggregated user statistics
 * Aggregates data from multiple sources and calculates XP/level
 * 
 * @param userId - User ID
 * @returns Updated UserStats object
 */
export async function updateUserStats(userId: string): Promise<any> {
  try {
    // Aggregate data from multiple sources
    // Note: These models may not exist yet, so we'll use try-catch for each
    let totalPosts = 0;
    let totalArticles = 0;
    let totalShortVideos = 0;
    let totalForumQuestions = 0;
    let totalForumAnswers = 0;
    let totalComments = 0;
    let totalLikesReceived = 0;
    let totalLikesGiven = 0;

    try {
      // Try to count posts (if Post model exists)
      const postModel = (prisma as any).post;
      if (postModel) {
        const articleTypes = ['article', 'ARTICLE'];
        const shortVideoTypes = ['video', 'VIDEO', 'short_video', 'SHORT_VIDEO'];

        totalPosts = await postModel.count({
          where: {
            authorId: userId,
            type: {
              notIn: [...articleTypes, ...shortVideoTypes],
            },
          },
        });
        totalArticles = await postModel.count({
          where: {
            authorId: userId,
            type: {
              in: articleTypes,
            },
          },
        });
        totalShortVideos = await postModel.count({
          where: {
            authorId: userId,
            type: {
              in: shortVideoTypes,
            },
          },
        });
      }
    } catch (err) {
      // Post model doesn't exist yet, use 0
      console.debug('Post model not found, skipping post counts');
    }

    try {
      // Try to count forum questions (if ForumQuestion model exists)
      const forumQuestionModel = (prisma as any).forumQuestion;
      if (forumQuestionModel) {
        totalForumQuestions = await forumQuestionModel.count({
          where: { userId },
        });
      }
    } catch (err) {
      console.debug('ForumQuestion model not found, skipping forum question counts');
    }

    try {
      // Try to count forum answers (if Answer model exists)
      const answerModel = (prisma as any).answer;
      if (answerModel) {
        totalForumAnswers = await answerModel.count({
          where: { userId },
        });
      }
    } catch (err) {
      console.debug('Answer model not found, skipping forum answer counts');
    }

    try {
      // Try to count comments (if Comment model exists)
      const commentModel = (prisma as any).comment;
      if (commentModel) {
        totalComments = await commentModel.count({
          where: { userId },
        });
      }
    } catch (err) {
      console.debug('Comment model not found, skipping comment counts');
    }

    try {
      // Try to count likes (if PostLike model exists)
      const postLikeModel = (prisma as any).postLike;
      if (postLikeModel) {
        totalLikesReceived = await postLikeModel.count({
          where: { post: { is: { authorId: userId } } },
        });
        totalLikesGiven = await postLikeModel.count({
          where: { userId },
        });
      }
    } catch (err) {
      console.debug('PostLike model not found, skipping like counts');
    }

    // Calculate streak
    const streakInfo = await calculateStreak(userId);

    const xp = await getLifetimeXp(userId);
    const level = calculateLevelProgress(xp).level;

    // Upsert UserStats
    const stats = await prisma.userStats.upsert({
      where: { userId },
      create: {
        userId,
        totalPosts,
        totalArticles,
        totalShortVideos,
        totalForumQuestions,
        totalForumAnswers,
        totalComments,
        totalLikesReceived,
        totalLikesGiven,
        totalViews: 0, // Will be updated when view tracking is implemented
        totalShares: 0, // Will be updated when share tracking is implemented
        connectionsCount: 0, // Will be updated when connections are implemented
        followersCount: 0, // Will be updated when followers are implemented
        followingCount: 0, // Will be updated when following is implemented
        currentStreak: streakInfo.currentStreak,
        longestStreak: streakInfo.longestStreak,
        lastActiveDate: streakInfo.lastActiveDate,
        totalActiveDays: streakInfo.totalActiveDays,
        xp,
        level,
        forumReputation: 0, // Will be updated when forum reputation is implemented
      },
      update: {
        totalPosts,
        totalArticles,
        totalShortVideos,
        totalForumQuestions,
        totalForumAnswers,
        totalComments,
        totalLikesReceived,
        totalLikesGiven,
        currentStreak: streakInfo.currentStreak,
        longestStreak: streakInfo.longestStreak,
        lastActiveDate: streakInfo.lastActiveDate,
        totalActiveDays: streakInfo.totalActiveDays,
        xp,
        level,
      },
    });

    console.log(
      `Stats updated for user ${userId}, lifetime XP: ${xp}, Level: ${level}, Streak: ${streakInfo.currentStreak}`
    );

    return stats;
  } catch (error) {
    console.error(`Failed to update stats for user ${userId}:`, error);
    throw error; // Re-throw so caller knows it failed
  }
}

export /**
 * Calculate contribution level based on activity count (GitHub-style)
 * 
 * @param activityCount - Number of contributions on a day
 * @returns Level 0-3 (0 = gray, 1 = light green, 2 = medium green, 3 = dark green)
 */
function getContributionLevel(activityCount: number): number {
  if (activityCount === 0) return 0;
  if (activityCount >= 1 && activityCount <= 3) return 1;
  if (activityCount >= 4 && activityCount <= 9) return 2;
  return 3; // 10+
}
