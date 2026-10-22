import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getRequestId, getRequestLogger } from "../../../../infrastructure/logging/logger";
import { randomUUID } from "crypto";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";
import { isUUID } from "../../../../shared/utils/username.util";
import { assertCanViewUser, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { evaluateLocationVisibility } from "../../../safety/services/safety-policy";
import { resolveTalkProfileIdentifier, getProfilePreviewLookupCacheKey, TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS, getProfilePreviewCacheKey, defaultPreviewStats, isProfileOnline, emptyRecentActivity } from "./support.controller";

export const getTalkProfilePreview = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  const requestId = getRequestId(req) || randomUUID();
  const log = getRequestLogger(req);
  const requestingUserId = req.user?.userId ? String(req.user.userId) : null;
  const identifier = resolveTalkProfileIdentifier(req.params.userId);

  if (!requestingUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!identifier) {
    res.status(400).json({ error: 'User ID or username is required' });
    return;
  }

  try {
    // The lookup cache only stores identifier -> user id resolution. Everything
    // viewer-specific (block/ban/suspension, location) runs per request below.
    const lookupCacheKey = getProfilePreviewLookupCacheKey(identifier);
    const cachedLookup = await cacheService.get<{ id?: string }>(lookupCacheKey);
    let targetUserId: string | null =
      cachedLookup && typeof cachedLookup.id === 'string' ? cachedLookup.id : null;

    if (!targetUserId) {
      const resolved = await prisma.user.findFirst({
        where: isUUID(identifier)
          ? { id: identifier, isBanned: false }
          : { username: identifier.toLowerCase(), isBanned: false },
        select: { id: true },
      });
      if (!resolved) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      targetUserId = resolved.id;
      await cacheService.set(
        lookupCacheKey,
        { id: targetUserId },
        TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS,
        [`user:${targetUserId}`, 'talk:profile-preview']
      );
    }

    try {
      await assertCanViewUser(requestingUserId, targetUserId);
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) {
        res.status(safety.statusCode).json(safety.body);
        return;
      }
      throw error;
    }

    const locationOwner = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { location: true, shareLocationPublic: true },
    });
    const viewerLocation = locationOwner && evaluateLocationVisibility({
      isOwner: requestingUserId === targetUserId,
      shareLocationPublic: locationOwner.shareLocationPublic,
    })
      ? locationOwner.location
      : null;
    const withViewerLocation = (body: any): any => ({
      ...body,
      user: { ...body.user, location: viewerLocation },
    });

    const cacheKey = getProfilePreviewCacheKey(targetUserId);
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) {
      res.status(200).json(withViewerLocation(cached));
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: targetUserId, isBanned: false },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        bio: true,
        college: true,
        degree: true,
        branch: true,
        currentYear: true,
        graduationYear: true,
        portfolioUrl: true,
        linkedinUrl: true,
        githubConnected: true,
        githubUsername: true,
        githubAvatarUrl: true,
        githubProfileUrl: true,
        githubLastSyncedAt: true,
        isOpenToOpportunities: true,
        isOnline: true,
        lastActiveAt: true,
        isVerified: true,
        interests: true,
        profileRing: true,
        visitLoaderGiftId: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [
      userStats,
      githubStats,
      userSkills,
      experiences,
      educationHistory,
      projects,
      certificates,
      achievements,
    ] = await Promise.all([
      prisma.userStats.findUnique({
        where: { userId: user.id },
        select: {
          xp: true,
          level: true,
          totalPosts: true,
          totalArticles: true,
          totalShortVideos: true,
          totalForumQuestions: true,
          totalForumAnswers: true,
          totalComments: true,
          totalLikesReceived: true,
          connectionsCount: true,
          followersCount: true,
          currentStreak: true,
          longestStreak: true,
          lastActiveDate: true,
          totalActiveDays: true,
        },
      }).catch(() => null),
      user.githubConnected
        ? prisma.gitHubStats.findUnique({
            where: { userId: user.id },
            select: {
              totalPublicRepos: true,
              totalStars: true,
              totalForks: true,
              followers: true,
              following: true,
              topLanguages: true,
              topRepos: true,
            },
          }).catch(() => null)
        : Promise.resolve(null),
      prisma.userSkill.findMany({
        where: { userId: user.id },
        include: { skill: true },
        orderBy: { createdAt: 'desc' },
        take: 24,
      }).catch(() => []),
      prisma.experience.findMany({
        where: { userId: user.id },
        orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
        take: 8,
      }).catch(() => []),
      prisma.education.findMany({
        where: { userId: user.id },
        orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
        take: 8,
      }).catch(() => []),
      prisma.project.findMany({
        where: { userId: user.id },
        orderBy: [{ featured: 'desc' }, { startDate: 'desc' }],
        take: 8,
      }).catch(() => []),
      prisma.certificate.findMany({
        where: { userId: user.id },
        orderBy: { issueDate: 'desc' },
        take: 8,
      }).catch(() => []),
      prisma.achievement.findMany({
        where: { userId: user.id },
        orderBy: { date: 'desc' },
        take: 8,
      }).catch(() => []),
    ]);

    const stats = {
      ...defaultPreviewStats,
      ...(userStats || {}),
      xpToNextLevel: 100,
    };

    const response = {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        avatar: user.profileImage,
        bannerImageUrl: user.bannerImageUrl,
        headline: user.headline,
        bio: user.bio,
        location: null, // viewer-specific; filled per request via withViewerLocation
        college: user.college || '',
        degree: user.degree,
        branch: user.branch || '',
        currentYear: user.currentYear,
        graduationYear: user.graduationYear,
        portfolioUrl: user.portfolioUrl,
        linkedinUrl: user.linkedinUrl,
        githubProfileUrl: user.githubProfileUrl,
        otherSocialUrls: null,
        isOpenToOpportunities: user.isOpenToOpportunities,
        isOnline: isProfileOnline(user),
        lastActiveAt: user.lastActiveAt,
        verified: user.isVerified,
        interests: user.interests || [],
        profileRing: user.profileRing,
        visitLoaderGiftId: user.visitLoaderGiftId,
        createdAt: user.createdAt,
      },
      stats,
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
        contributionCalendar: null,
        lastSyncedAt: user.githubLastSyncedAt,
      },
      activityHeatmap: [],
      recentActivity: emptyRecentActivity,
      skills: userSkills.map((userSkill) => ({
        id: userSkill.id,
        skill: {
          id: userSkill.skill.id,
          name: userSkill.skill.name,
          category: userSkill.skill.category,
        },
        proficiency: userSkill.proficiency,
        yearsOfExp: userSkill.yearsOfExp,
      })),
      experiences,
      education: educationHistory,
      projects,
      certificates,
      achievements,
    };

    const cacheTags = [`user:${user.id}`, 'talk:profile-preview'];
    await cacheService.set(cacheKey, response, TALK_PROFILE_PREVIEW_CACHE_TTL_SECONDS, cacheTags);

    res.status(200).json(withViewerLocation(response));
  } catch (error) {
    const err = error as Error;
    log.error({
      event: 'talk.profile_preview.failure',
      requestId,
      userId: requestingUserId,
      target: identifier,
      message: err.message,
    });
    res.status(500).json({ error: 'Profile preview is unavailable right now' });
  }
};
