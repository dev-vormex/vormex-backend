import { prisma } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { isUUID } from "../../../../shared/utils/username.util";
import type { FullProfileResponse } from "../../types/profile.types";
import { getActivityHeatmap } from "../../../engagement/services/activity.service";
import { socialProofService } from "../social-proof.service";
import { calculateLevelProgress } from "../../../engagement/services/progress.service";
import { getPremiumAccessSnapshot } from "../../../premium/services/premium-access.service";
import { buildProfileCustomizationResponseFields } from "../user-response.service";
import { serializeCoarseLocation } from "../../utils/location-dto.util";
import { normalizeProfileCacheIdentifier, profileResponseCacheKey, isLegacyProfileAvifUrl, trackProfileViewLater, PROFILE_BUNDLE_CACHE_TTL_SECONDS, backfillGitHubContributionCalendar, migrateLegacyProfileAvatarToWebp, isProfileUserOnline } from "./normalize-profile-cache-identifier.service";
import { getUnifiedContentFeed } from "./get-unified-content-feed.service";

/**
 * Get full profile with all data (user info, stats, GitHub, activity, feed)
 * 
 * @param requestingUserId - ID of user making the request (null if anonymous)
 * @param targetUsernameOrId - Username or UUID of target user
 * @returns FullProfileResponse with all profile data
 */
export async function getFullProfile(
  requestingUserId: string | null,
  targetUsernameOrId: string
): Promise<FullProfileResponse> {
  try {
    const identifier = normalizeProfileCacheIdentifier(targetUsernameOrId);
    const requestedCacheKey = profileResponseCacheKey(
      'bundle',
      requestingUserId,
      identifier
    );
    const requestedCached = await cacheService.get<FullProfileResponse>(requestedCacheKey);
    if (requestedCached && !isLegacyProfileAvifUrl(requestedCached.user.avatar)) {
      trackProfileViewLater(requestingUserId, requestedCached.user.id);
      return requestedCached;
    }
    if (requestedCached) {
      await cacheService.del(requestedCacheKey);
    }

    const coordinated = await cacheService.getOrSet(
      requestedCacheKey,
      async () => {
        // Find target user by UUID or username
        const user = await prisma.user.findFirst({
          where: isUUID(identifier)
            ? { id: identifier }
            : { username: identifier.toLowerCase() },
        });

        if (!user) {
          throw new Error('User not found');
        }

        const targetUserId = user.id;
        const isOwner = requestingUserId !== null && requestingUserId === targetUserId;

        const canonicalCacheKey = profileResponseCacheKey('bundle', requestingUserId, targetUserId);
        const cached = requestedCacheKey === canonicalCacheKey
          ? null
          : await cacheService.get<FullProfileResponse>(canonicalCacheKey);
        if (cached && !isLegacyProfileAvifUrl(cached.user.avatar)) {
          await cacheService.set(
            requestedCacheKey,
            cached,
            PROFILE_BUNDLE_CACHE_TTL_SECONDS,
            [`user:${targetUserId}`]
          );
          return cached;
        }

    // All profiles are public - no privacy checks needed

    // Fetch all related data in parallel
    const [
      userStats,
      githubStats,
      activityHeatmap,
      recentActivity,
      userSkills,
      experiences,
      educationHistory,
      projects,
      certificates,
      achievements,
      premiumSnapshot,
      isProfileSaved,
    ] = await Promise.all([
      // UserStats
      prisma.userStats.findUnique({
        where: { userId: targetUserId },
      }).catch(() => null),

      // GitHubStats (only if connected)
      user.githubConnected
        ? prisma.gitHubStats.findUnique({
            where: { userId: targetUserId },
          }).catch(() => null)
        : Promise.resolve(null),

      // Activity heatmap (last 365 days - default view)
      getActivityHeatmap(targetUserId).catch(() => ({
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
      })),

      // Recent activity feed (first 20 items)
      getUnifiedContentFeed(targetUserId, 1, 20, 'all', requestingUserId).catch(() => ({
        items: [],
        totalCount: 0,
        hasMore: false,
      })),

      // Skills
      prisma.userSkill.findMany({
        where: { userId: targetUserId },
        include: { skill: true },
        orderBy: { createdAt: 'desc' },
      }).catch(() => []),

      // Experiences
      prisma.experience.findMany({
        where: { userId: targetUserId },
        orderBy: [
          { isCurrent: 'desc' },
          { startDate: 'desc' },
        ],
      }).catch(() => []),

      // Education
      prisma.education.findMany({
        where: { userId: targetUserId },
        orderBy: [
          { isCurrent: 'desc' },
          { startDate: 'desc' },
        ],
      }).catch(() => []),

      // Projects
      prisma.project.findMany({
        where: { userId: targetUserId },
        orderBy: [
          { featured: 'desc' },
          { startDate: 'desc' },
        ],
      }).catch(() => []),

      // Certificates
      prisma.certificate.findMany({
        where: { userId: targetUserId },
        orderBy: { issueDate: 'desc' },
      }).catch(() => []),

      // Achievements
      prisma.achievement.findMany({
        where: { userId: targetUserId },
        orderBy: { date: 'desc' },
      }).catch(() => []),

      getPremiumAccessSnapshot(targetUserId).catch(() => ({
        isPremium: false,
      })),

      requestingUserId && !isOwner
        ? socialProofService.isProfileSaved(requestingUserId, targetUserId).catch(() => false)
        : Promise.resolve(false),
    ]);

    // Social counters are maintained transactionally on their write paths. Recounting
    // posts, follows, and connections here adds three pool competitors per profile open.
    const stats = userStats ? { ...userStats } : {
      xp: 0,
      level: 1,
      totalPosts: 0,
      totalArticles: 0,
      totalShortVideos: 0,
      totalForumQuestions: 0,
      totalForumAnswers: 0,
      totalComments: 0,
      totalLikesReceived: 0,
      connectionsCount: 0,
      followersCount: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      totalActiveDays: 0,
    };
    
    const levelProgress = calculateLevelProgress(stats.xp);
    stats.level = levelProgress.level;

    let contributionCalendar = githubStats?.contributionData || null;
    if (
      user.githubConnected &&
      !contributionCalendar &&
      user.githubAccessToken &&
      user.githubUsername &&
      githubStats
    ) {
      void backfillGitHubContributionCalendar(user, targetUserId).catch((error) => {
        console.warn(
          `Failed to backfill GitHub contribution calendar for ${targetUserId}:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
      });
    }

    // Build GitHub object
    const github = {
      connected: user.githubConnected || false,
      username: user.githubUsername,
      avatarUrl: user.githubAvatarUrl,
      profileUrl: user.githubProfileUrl,
      stats: githubStats
        ? {
            totalPublicRepos: githubStats.totalPublicRepos,
            totalStars: githubStats.totalStars,
            totalForks: githubStats.totalForks,
            followers: githubStats.followers,
            following: githubStats.following,
            topLanguages: githubStats.topLanguages || {},
            topRepos: githubStats.topRepos || [],
          }
        : null,
      contributionCalendar,
      lastSyncedAt: user.githubLastSyncedAt,
    };

    const canAccessProfileCustomization = Boolean(
      (premiumSnapshot as any).canAccessProfileCustomization
    );
    const customizationFields = buildProfileCustomizationResponseFields(
      user,
      canAccessProfileCustomization
    );
    const profileImageForResponse = await migrateLegacyProfileAvatarToWebp(
      targetUserId,
      user.profileImage
    );
    const canShowLocation = isOwner || user.shareLocationPublic === true;
    const location = canShowLocation ? serializeCoarseLocation(user) : null;

    // Build user object (exclude sensitive fields)
    const userResponse = {
      id: user.id,
      username: user.username, // Username is required
      name: user.name,
      ...(isOwner && { email: user.email }), // Only include email if owner
      avatar: profileImageForResponse,
      profileImage: profileImageForResponse,
      bannerImageUrl: user.bannerImageUrl,
      headline: user.headline,
      bio: user.bio,
      location,
      college: user.college || '',
      degree: user.degree,
      branch: user.branch || '',
      currentYear: user.currentYear,
      graduationYear: user.graduationYear,
      portfolioUrl: user.portfolioUrl,
      linkedinUrl: user.linkedinUrl,
      githubProfileUrl: user.githubProfileUrl,
      otherSocialUrls: user.otherSocialUrls,
      isOpenToOpportunities: user.isOpenToOpportunities,
      isOnline: isProfileUserOnline(user),
      lastActiveAt: user.lastActiveAt,
      verified: user.isVerified,
      isVerified: user.isVerified,
      profileBadgeStyle: customizationFields.profileBadgeStyle,
      isPremium: Boolean((premiumSnapshot as any).isPremium),
      canAccessProfileCustomization,
      profileRing: customizationFields.profileRing,
      visitLoaderGiftId: customizationFields.visitLoaderGiftId,
      profileTheme: customizationFields.profileTheme,
      createdAt: user.createdAt,
    };

    // Format skills for response
    const formattedSkills = userSkills.map((us) => ({
      id: us.id,
      skill: {
        id: us.skill.id,
        name: us.skill.name,
        category: us.skill.category,
      },
      proficiency: us.proficiency,
      yearsOfExp: us.yearsOfExp,
    }));

    // Log profile view
    console.log(
      `Profile viewed: ${targetUsernameOrId} by ${requestingUserId || 'anonymous'}`
    );

    const response = {
      user: {
        ...userResponse,
        interests: user.interests || [],
      },
      stats: {
        ...stats,
        xpToNextLevel: levelProgress.xpToNextLevel,
      },
      github: github as any,
      activityHeatmap: activityHeatmap.days || [], // Extract days array for backward compatibility
      recentActivity,
      skills: formattedSkills,
      experiences,
      education: educationHistory,
      projects,
      certificates,
      achievements,
      viewerContext: {
        isProfileSaved: Boolean(isProfileSaved),
      },
    };
    const cacheKeys = Array.from(new Set([
      requestedCacheKey,
      canonicalCacheKey,
      profileResponseCacheKey('bundle', requestingUserId, user.username),
    ]));
    await Promise.all(
      cacheKeys.map((cacheKey) =>
        cacheService.set(
          cacheKey,
          response,
          PROFILE_BUNDLE_CACHE_TTL_SECONDS,
          [`user:${targetUserId}`]
        )
      )
    );
        return response;
      },
      {
        ttlSeconds: PROFILE_BUNDLE_CACHE_TTL_SECONDS,
        lockTtlMs: 15_000,
      }
    );
    trackProfileViewLater(requestingUserId, coordinated.user.id);
    return coordinated;
  } catch (error) {
    console.error(
      `Failed to get full profile for ${targetUsernameOrId}:`,
      error
    );
    throw error;
  }
}
