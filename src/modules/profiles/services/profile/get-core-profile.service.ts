import { prisma } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { isUUID } from "../../../../shared/utils/username.util";
import type { CoreProfileResponse, ProfileSectionsResponse } from "../../types/profile.types";
import { calculateLevelProgress } from "../../../engagement/services/progress.service";
import { serializeCoarseLocation } from "../../utils/location-dto.util";
import { normalizeProfileCacheIdentifier, profileResponseCacheKey, trackProfileViewLater, CORE_PROFILE_USER_SELECT, PROFILE_CORE_CACHE_TTL_SECONDS, ProfileRelationshipRow, emptyProfileStats, isProfileUserOnline, toProfileConnectionState, PROFILE_SECTIONS_CACHE_TTL_SECONDS } from "./normalize-profile-cache-identifier.service";

/**
 * Load the default profile header/counts path with one identity query followed
 * by bounded aggregate, connection, and follow-state branches.
 */
export async function getCoreProfile(
  requestingUserId: string | null,
  targetUsernameOrId: string
): Promise<CoreProfileResponse> {
  const identifier = normalizeProfileCacheIdentifier(targetUsernameOrId);
  const requestedCacheKey = profileResponseCacheKey(
    'core',
    requestingUserId,
    identifier
  );
  const requestedCached = await cacheService.get<CoreProfileResponse>(requestedCacheKey);
  if (requestedCached) {
    trackProfileViewLater(requestingUserId, requestedCached.user.id);
    return requestedCached;
  }

  const coordinated = await cacheService.getOrSet(
    requestedCacheKey,
    async () => {
      const user = await prisma.user.findFirst({
        where: isUUID(identifier)
          ? { id: identifier }
          : { username: identifier.toLowerCase() },
        select: CORE_PROFILE_USER_SELECT,
      });
      if (!user) {
        throw new Error('User not found');
      }

      const targetUserId = user.id;
      const isOwner = requestingUserId !== null && requestingUserId === targetUserId;
      const canonicalCacheKey = profileResponseCacheKey('core', requestingUserId, targetUserId);
      const cached = requestedCacheKey === canonicalCacheKey
        ? null
        : await cacheService.get<CoreProfileResponse>(canonicalCacheKey);
      if (cached) {
        await cacheService.set(
          requestedCacheKey,
          cached,
          PROFILE_CORE_CACHE_TTL_SECONDS,
          [`user:${targetUserId}`]
        );
        return cached;
      }

      // These bounded relationship branches replace two extra authenticated
      // client requests after the profile header has already loaded.
      const [userStats, relationship] = await Promise.all([
        prisma.userStats.findUnique({ where: { userId: targetUserId } }).catch(() => null),
        requestingUserId && !isOwner
          ? prisma.$queryRaw<ProfileRelationshipRow[]>`
              SELECT
                relationship.id AS "connectionId",
                relationship."requesterId" AS "requesterId",
                relationship.status AS "status",
                EXISTS (
                  SELECT 1
                  FROM follows forward_follow
                  WHERE forward_follow."followerId" = ${requestingUserId}
                    AND forward_follow."followingId" = ${targetUserId}
                ) AS "isFollowing",
                EXISTS (
                  SELECT 1
                  FROM follows reverse_follow
                  WHERE reverse_follow."followerId" = ${targetUserId}
                    AND reverse_follow."followingId" = ${requestingUserId}
                ) AS "isFollowedBy"
              FROM (SELECT 1) seed
              LEFT JOIN LATERAL (
                SELECT connection.id, connection."requesterId", connection.status
                FROM connections connection
                WHERE (
                  connection."requesterId" = ${requestingUserId}
                  AND connection."addresseeId" = ${targetUserId}
                ) OR (
                  connection."requesterId" = ${targetUserId}
                  AND connection."addresseeId" = ${requestingUserId}
                )
                LIMIT 1
              ) relationship ON TRUE
            `.then((rows) => rows[0] || null).catch(() => null)
          : Promise.resolve(null),
      ]);

  const sourceStats = userStats || emptyProfileStats();
  const levelProgress = calculateLevelProgress(sourceStats.xp);
  const canShowLocation = isOwner || user.shareLocationPublic === true;
  const response: CoreProfileResponse = {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      ...(isOwner ? { email: user.email } : {}),
      avatar: user.profileImage,
      profileImage: user.profileImage,
      bannerImageUrl: user.bannerImageUrl,
      headline: user.headline,
      bio: user.bio,
      location: canShowLocation ? serializeCoarseLocation(user) : null,
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
      interests: user.interests || [],
      createdAt: user.createdAt,
    },
    stats: {
      xp: sourceStats.xp,
      level: levelProgress.level,
      xpToNextLevel: levelProgress.xpToNextLevel,
      totalPosts: sourceStats.totalPosts,
      totalArticles: sourceStats.totalArticles,
      totalShortVideos: sourceStats.totalShortVideos,
      totalForumQuestions: sourceStats.totalForumQuestions,
      totalForumAnswers: sourceStats.totalForumAnswers,
      totalComments: sourceStats.totalComments,
      totalLikesReceived: sourceStats.totalLikesReceived,
      connectionsCount: sourceStats.connectionsCount,
      followersCount: sourceStats.followersCount,
      currentStreak: sourceStats.currentStreak,
      longestStreak: sourceStats.longestStreak,
      lastActiveDate: sourceStats.lastActiveDate,
      totalActiveDays: sourceStats.totalActiveDays,
    },
        viewerContext: toProfileConnectionState(
          relationship,
          requestingUserId
        ),
  };

  const cacheKeys = Array.from(new Set([
    requestedCacheKey,
    canonicalCacheKey,
    profileResponseCacheKey('core', requestingUserId, user.username),
  ]));
  await Promise.all(
    cacheKeys.map((cacheKey) =>
      cacheService.set(
        cacheKey,
        response,
        PROFILE_CORE_CACHE_TTL_SECONDS,
        [`user:${targetUserId}`]
      )
    )
  );
      return response;
    },
    {
      ttlSeconds: PROFILE_CORE_CACHE_TTL_SECONDS,
      lockTtlMs: 5_000,
    }
  );
  trackProfileViewLater(requestingUserId, coordinated.user.id);
  return coordinated;
}

/**
 * Load the independently cacheable lower profile sections. This intentionally
 * excludes feed and activity; those already have cursor/section endpoints and
 * should only run when their own UI becomes visible.
 */
export async function getProfileSections(
  targetUsernameOrId: string
): Promise<ProfileSectionsResponse> {
  const identifier = normalizeProfileCacheIdentifier(targetUsernameOrId);
  const requestedCacheKey = profileResponseCacheKey('sections', null, identifier);
  const cached = await cacheService.get<ProfileSectionsResponse>(requestedCacheKey);
  if (cached) return cached;

  return cacheService.getOrSet(
    requestedCacheKey,
    async () => {
      const user = await prisma.user.findFirst({
        where: isUUID(identifier)
          ? { id: identifier }
          : { username: identifier.toLowerCase() },
        select: {
          id: true,
          username: true,
          githubConnected: true,
          githubUsername: true,
          githubAvatarUrl: true,
          githubProfileUrl: true,
          githubLastSyncedAt: true,
        },
      });
      if (!user) throw new Error('User not found');

      const targetUserId = user.id;
      const canonicalCacheKey = profileResponseCacheKey('sections', null, targetUserId);
      if (canonicalCacheKey !== requestedCacheKey) {
        const canonicalCached = await cacheService.get<ProfileSectionsResponse>(canonicalCacheKey);
        if (canonicalCached) {
          await cacheService.set(
            requestedCacheKey,
            canonicalCached,
            PROFILE_SECTIONS_CACHE_TTL_SECONDS,
            [`user:${targetUserId}`]
          );
          return canonicalCached;
        }
      }

      const [userSkills, experiences, education, projects, certificates, achievements, githubStats] =
        await Promise.all([
          prisma.userSkill.findMany({
            where: { userId: targetUserId },
            include: { skill: true },
            orderBy: { createdAt: 'desc' },
          }).catch(() => []),
          prisma.experience.findMany({
            where: { userId: targetUserId },
            orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
          }).catch(() => []),
          prisma.education.findMany({
            where: { userId: targetUserId },
            orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
          }).catch(() => []),
          prisma.project.findMany({
            where: { userId: targetUserId },
            orderBy: [{ featured: 'desc' }, { startDate: 'desc' }],
          }).catch(() => []),
          prisma.certificate.findMany({
            where: { userId: targetUserId },
            orderBy: { issueDate: 'desc' },
          }).catch(() => []),
          prisma.achievement.findMany({
            where: { userId: targetUserId },
            orderBy: { date: 'desc' },
          }).catch(() => []),
          user.githubConnected
            ? prisma.gitHubStats.findUnique({ where: { userId: targetUserId } }).catch(() => null)
            : Promise.resolve(null),
        ]);

      const response: ProfileSectionsResponse = {
        skills: userSkills.map((entry) => ({
          id: entry.id,
          skill: {
            id: entry.skill.id,
            name: entry.skill.name,
            category: entry.skill.category,
          },
          proficiency: entry.proficiency,
          yearsOfExp: entry.yearsOfExp,
        })),
        experiences,
        education,
        projects,
        certificates,
        achievements,
        github: {
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
          contributionCalendar: githubStats?.contributionData || null,
          lastSyncedAt: user.githubLastSyncedAt,
        },
      };

      const cacheKeys = Array.from(new Set([
        requestedCacheKey,
        canonicalCacheKey,
        profileResponseCacheKey('sections', null, user.username),
      ]));
      await Promise.all(cacheKeys.map((cacheKey) =>
        cacheService.set(
          cacheKey,
          response,
          PROFILE_SECTIONS_CACHE_TTL_SECONDS,
          [`user:${targetUserId}`]
        )
      ));
      return response;
    },
    {
      ttlSeconds: PROFILE_SECTIONS_CACHE_TTL_SECONDS,
      lockTtlMs: 10_000,
    }
  );
}
