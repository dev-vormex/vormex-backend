import { prisma } from '../config/prisma';
import type {
  ActivityType,
  StreakInfo,
  ActivityHeatmapDay,
  ActivitySummary,
} from '../types/activity.types';

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
  count: number = 1
): Promise<void> {
  try {
    const today = getTodayDateString();
    const todayDate = new Date(today + 'T00:00:00.000Z');

    // Find or create UserDailyActivity for today
    await prisma.userDailyActivity.findUnique({
      where: {
        userId_date: {
          userId,
          date: todayDate,
        },
      },
    });

    // Prepare update data based on activity type
    const updateData: any = {
      isActive: true,
    };

    switch (activityType) {
      case 'post':
        updateData.postsCount = { increment: count };
        break;
      case 'article':
        updateData.articlesCount = { increment: count };
        break;
      case 'comment':
        updateData.commentsCount = { increment: count };
        break;
      case 'forum_question':
        updateData.forumQuestionsCount = { increment: count };
        break;
      case 'forum_answer':
        updateData.forumAnswersCount = { increment: count };
        break;
      case 'like':
        updateData.likesGivenCount = { increment: count };
        break;
      case 'message':
        updateData.messagesCount = { increment: count };
        break;
      case 'short_video':
        updateData.postsCount = { increment: count };
        break;
      case 'connection':
        // Connections mark the day as active but don't increment a counter
        // The connection count is tracked in UserStats.connectionsCount
        break;
      case 'login':
        // Logins mark the day as active but don't increment a counter
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
        ...updateData,
        postsCount: activityType === 'post' || activityType === 'short_video' ? count : 0,
        articlesCount: activityType === 'article' ? count : 0,
        commentsCount: activityType === 'comment' ? count : 0,
        forumQuestionsCount: activityType === 'forum_question' ? count : 0,
        forumAnswersCount: activityType === 'forum_answer' ? count : 0,
        likesGivenCount: activityType === 'like' ? count : 0,
        messagesCount: activityType === 'message' ? count : 0,
        isActive: true,
      },
      update: updateData,
    });

    console.log(`Activity recorded: user ${userId}, type: ${activityType}, count: ${count}`);

    // Trigger stats update asynchronously (don't await)
    updateUserStats(userId).catch((err) =>
      console.error(`Failed to update stats for user ${userId}:`, err)
    );
  } catch (error) {
    console.error(`Failed to record activity for user ${userId}:`, error);
    // Don't throw - activity tracking is non-critical
  }
}

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
 * Calculate XP required for next level
 * 
 * @param currentLevel - Current user level
 * @returns XP required to reach next level
 */
function calculateXpForNextLevel(currentLevel: number): number {
  // Simple formula: 100 XP per level
  return (currentLevel + 1) * 100;
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

    // Calculate XP based on activity
    // XP = (posts * 10) + (articles * 25) + (comments * 2) + (forumQuestions * 15) + (forumAnswers * 20) + (likesReceived * 1)
    // Add streak bonus: currentStreak * 5
    const xp =
      totalPosts * 10 +
      totalArticles * 25 +
      totalComments * 2 +
      totalForumQuestions * 15 +
      totalForumAnswers * 20 +
      totalLikesReceived * 1 +
      streakInfo.currentStreak * 5;

    // Calculate level from XP
    // Simple formula: level = Math.floor(xp / 100) + 1 (100 XP per level)
    const level = Math.floor(xp / 100) + 1;

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
      `Stats updated for user ${userId}, XP: ${xp}, Level: ${level}, Streak: ${streakInfo.currentStreak}`
    );

    return stats;
  } catch (error) {
    console.error(`Failed to update stats for user ${userId}:`, error);
    throw error; // Re-throw so caller knows it failed
  }
}

/**
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

/**
 * Get contribution years available for a user
 * 
 * @param userId - User ID
 * @returns Years array and joined year
 */
export async function getContributionYears(userId: string): Promise<{
  years: number[];
  joinedYear: number;
}> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const joinedYear = user.createdAt.getUTCFullYear();
    const currentYear = new Date().getUTCFullYear();

    // Generate array from joined year to current year
    const years: number[] = [];
    for (let year = joinedYear; year <= currentYear; year++) {
      years.push(year);
    }

    return {
      years,
      joinedYear,
    };
  } catch (error) {
    console.error(`Failed to get contribution years for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Get activity heatmap data for GitHub-style contribution calendar
 * Matches GitHub's exact behavior: respects joined date, supports year view
 * 
 * @param userId - User ID
 * @param year - Optional year (if provided, show Jan 1 - Dec 31 of that year). If null, show last 365 days
 * @returns ActivityHeatmapResponse with days array and stats
 */
export async function getActivityHeatmap(
  userId: string,
  year?: number
): Promise<{
  days: ActivityHeatmapDay[];
  stats: {
    totalContributions: number;
    currentStreak: number;
    longestStreak: number;
    contributionLevels: {
      level0: number;
      level1: number;
      level2: number;
      level3: number;
    };
  };
}> {
  try {
    // Fetch user to get joined date (createdAt)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const joinedDate = new Date(user.createdAt);
    joinedDate.setUTCHours(0, 0, 0, 0);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Calculate date range
    let requestedStartDate: Date;
    let requestedEndDate: Date;

    if (year !== undefined && year !== null) {
      // Year view: Jan 1 to Dec 31 of specified year
      requestedStartDate = new Date(Date.UTC(year, 0, 1)); // Jan 1
      requestedEndDate = new Date(Date.UTC(year, 11, 31)); // Dec 31
    } else {
      // Default: last 365 days (rolling window)
      requestedStartDate = new Date(today);
      requestedStartDate.setUTCDate(requestedStartDate.getUTCDate() - 365);
      requestedEndDate = today;
    }

    // Never show dates before user joined or after today
    const actualStartDate = new Date(
      Math.max(requestedStartDate.getTime(), joinedDate.getTime())
    );
    const actualEndDate = new Date(
      Math.min(requestedEndDate.getTime(), today.getTime())
    );

    // If requested year is before user joined, return empty
    if (year !== undefined && year !== null && year < joinedDate.getUTCFullYear()) {
      return {
        days: [],
        stats: {
          totalContributions: 0,
          currentStreak: 0,
          longestStreak: 0,
          contributionLevels: {
            level0: 0,
            level1: 0,
            level2: 0,
            level3: 0,
          },
        },
      };
    }

    // Fetch activity records in date range
    const activities = await prisma.userDailyActivity.findMany({
      where: {
        userId,
        date: {
          gte: actualStartDate,
          lte: actualEndDate,
        },
      },
      orderBy: { date: 'asc' },
    });

    // Create a map of date -> activity for quick lookup
    const activityMap = new Map<string, typeof activities[0]>();
    for (const activity of activities) {
      const dateStr = activity.date.toISOString().split('T')[0];
      activityMap.set(dateStr, activity);
    }

    // Generate array of ALL dates in range (fill missing dates with zero activity)
    const days: ActivityHeatmapDay[] = [];
    const currentDate = new Date(actualStartDate);

    let totalContributions = 0;
    const contributionLevels = {
      level0: 0,
      level1: 0,
      level2: 0,
      level3: 0,
    };

    while (currentDate <= actualEndDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const activity = activityMap.get(dateStr);

      let activityCount = 0;
      let isActive = false;
      let breakdown: ActivityHeatmapDay['breakdown'] | undefined;

      if (activity && activity.isActive) {
        activityCount =
          activity.postsCount +
          activity.articlesCount +
          activity.commentsCount +
          activity.forumQuestionsCount +
          activity.forumAnswersCount +
          activity.likesGivenCount +
          activity.messagesCount;

        isActive = true;
        totalContributions += activityCount;

        breakdown = {
          posts: activity.postsCount,
          articles: activity.articlesCount,
          comments: activity.commentsCount,
          forumQuestions: activity.forumQuestionsCount,
          forumAnswers: activity.forumAnswersCount,
          likes: activity.likesGivenCount,
          messages: activity.messagesCount,
        };
      }

      // Calculate contribution level
      const level = getContributionLevel(activityCount);
      contributionLevels[`level${level}` as keyof typeof contributionLevels]++;

      days.push({
        date: dateStr,
        activityCount,
        isActive,
        level,
        ...(breakdown && { breakdown }),
      });

      // Move to next day
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    // Calculate streaks
    const streakInfo = await calculateStreak(userId);

    return {
      days,
      stats: {
        totalContributions,
        currentStreak: streakInfo.currentStreak,
        longestStreak: streakInfo.longestStreak,
        contributionLevels,
      },
    };
  } catch (error) {
    console.error(`Failed to get activity heatmap for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Get comprehensive activity summary for a user
 * 
 * @param userId - User ID
 * @returns ActivitySummary with totals, streak, and XP/level info
 */
export async function getActivitySummary(userId: string): Promise<ActivitySummary> {
  try {
    // Fetch UserStats from database
    let stats = await prisma.userStats.findUnique({
      where: { userId },
    });

    // If not found, update stats first
    if (!stats) {
      stats = await updateUserStats(userId);
    }

    if (!stats) {
      throw new Error('Failed to get user stats');
    }

    // Calculate totals
    const totalContent =
      stats.totalPosts + stats.totalArticles + stats.totalShortVideos;
    const totalForumActivity =
      stats.totalForumQuestions + stats.totalForumAnswers;
    const totalEngagement = stats.totalLikesReceived + stats.totalComments;

    // Calculate XP to next level
    const xpToNextLevel = calculateXpForNextLevel(stats.level) - stats.xp;

    // Build streak info
    const streak: StreakInfo = {
      currentStreak: stats.currentStreak,
      longestStreak: stats.longestStreak,
      lastActiveDate: stats.lastActiveDate,
      totalActiveDays: stats.totalActiveDays,
    };

    return {
      totalContent,
      totalForumActivity,
      totalEngagement,
      streak,
      xpAndLevel: {
        xp: stats.xp,
        level: stats.level,
        xpToNextLevel: Math.max(0, xpToNextLevel), // Ensure non-negative
      },
    };
  } catch (error) {
    console.error(`Failed to get activity summary for user ${userId}:`, error);
    // Return default values on error
    return {
      totalContent: 0,
      totalForumActivity: 0,
      totalEngagement: 0,
      streak: {
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: null,
        totalActiveDays: 0,
      },
      xpAndLevel: {
        xp: 0,
        level: 1,
        xpToNextLevel: 100,
      },
    };
  }
}

