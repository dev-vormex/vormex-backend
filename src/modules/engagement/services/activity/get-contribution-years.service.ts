import { prisma } from "../../../../config/prisma";
import type { ActivityHeatmapDay } from "../../types/activity.types";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { ACTIVITY_YEARS_CACHE_TTL_SECONDS, activityCacheTags, ACTIVITY_HEATMAP_CACHE_TTL_SECONDS } from "./record-activity.service";
import { getContributionLevel, calculateStreak } from "./calculate-streak.service";

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
    const cacheKey = `activity:years:${userId}`;
    const cached = await cacheService.get<{ years: number[]; joinedYear: number }>(cacheKey);
    if (cached) {
      return cached;
    }

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

    const response = {
      years,
      joinedYear,
    };
    await cacheService.set(
      cacheKey,
      response,
      ACTIVITY_YEARS_CACHE_TTL_SECONDS,
      activityCacheTags(userId)
    );
    return response;
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
    const cacheKey = `activity:heatmap:${userId}:${year ?? 'rolling'}`;
    const cached = await cacheService.get<{
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
    }>(cacheKey);
    if (cached) {
      return cached;
    }

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
      const emptyResponse = {
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
      await cacheService.set(
        cacheKey,
        emptyResponse,
        ACTIVITY_HEATMAP_CACHE_TTL_SECONDS,
        activityCacheTags(userId)
      );
      return emptyResponse;
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

    const response = {
      days,
      stats: {
        totalContributions,
        currentStreak: streakInfo.currentStreak,
        longestStreak: streakInfo.longestStreak,
        contributionLevels,
      },
    };
    await cacheService.set(
      cacheKey,
      response,
      ACTIVITY_HEATMAP_CACHE_TTL_SECONDS,
      activityCacheTags(userId)
    );
    return response;
  } catch (error) {
    console.error(`Failed to get activity heatmap for user ${userId}:`, error);
    throw error;
  }
}
