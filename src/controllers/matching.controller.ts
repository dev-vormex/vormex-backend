// @ts-nocheck
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { cacheService } from '../services/cache.service';
import {
  applyPremiumVisibilityToUser,
  getPremiumVisibilityByUserIds,
  sortByPremiumVisibility,
} from '../services/premium-visibility.service';
import {
  MATCHING_ENGINE_USER_SELECT,
  buildMatchingCandidateWhere,
  getConnectedOrPendingUserIds,
  rankUserMatches,
  serializeMatchedUser,
} from '../services/matching-engine.service';
import { getBlockedUserIds } from '../services/trust-safety.service';

const SMART_MATCH_CACHE_VERSION = 'v1';
const SMART_MATCH_CACHE_TTL_SECONDS = 60;
const SMART_MATCH_TYPES = new Set(['all', 'same_campus', 'same_goal', 'mentor', 'mentee']);

const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

const smartMatchCacheKey = (params: {
  userId: string;
  type: string;
  page: number;
  limit: number;
}): string =>
  [
    'matching:smart',
    SMART_MATCH_CACHE_VERSION,
    `user:${params.userId}`,
    `type:${params.type}`,
    `page:${params.page}`,
    `limit:${params.limit}`,
  ].join(':');

const smartMatchCacheTags = (userId: string): string[] =>
  uniqueCacheTags([
    'matching:global',
    `matching:user:${userId}`,
    `people:user:${userId}`,
    `people:connections:${userId}`,
  ]);

/**
 * Get smart matches based on type filter
 * GET /api/matching/smart?type=all|same_campus|same_goal|mentor|mentee&page=1&limit=20
 */
export const getSmartMatches = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawType = String(req.query.type || 'all');
    const type = SMART_MATCH_TYPES.has(rawType) ? rawType : 'all';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const cacheKey = smartMatchCacheKey({ userId, type, page, limit });
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: MATCHING_ENGINE_USER_SELECT,
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [excludeIds, blockedUserIds] = await Promise.all([
      getConnectedOrPendingUserIds(userId),
      getBlockedUserIds(userId),
    ]);
    const where = buildMatchingCandidateWhere(currentUser, {
      type,
      excludedIds: [...excludeIds, ...blockedUserIds],
    });

    const candidateTake = Math.min(Math.max(skip + limit * 3, limit), 150);
    const [candidateUsers, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: 0,
        take: candidateTake,
        orderBy: [{ lastActiveAt: 'desc' }, { id: 'asc' }],
        select: MATCHING_ENGINE_USER_SELECT,
      }),
      prisma.user.count({ where }),
    ]);

    const visibilityByUser = await getPremiumVisibilityByUserIds(
      candidateUsers.map((user) => user.id)
    );
    const matches = rankUserMatches(currentUser, candidateUsers, { visibilityByUser })
      .slice(skip, skip + limit)
      .map((match) => ({
        user: serializeMatchedUser(match.candidate, visibilityByUser.get(match.candidate.id)),
        score: match.score,
        matchPercentage: match.matchPercentage,
        reasons: match.reasons,
        tags: match.tags,
        whyMatched: match.whyMatched,
        sharedSignals: match.sharedSignals,
      }));

    const response = {
      matches,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: page < Math.ceil(total / limit),
    };

    await cacheService.set(cacheKey, response, SMART_MATCH_CACHE_TTL_SECONDS, smartMatchCacheTags(userId));

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching smart matches:', error);
    res.status(500).json({ error: 'Failed to fetch smart matches' });
  }
};

/**
 * Get mentor matches (users who can teach what current user wants to learn)
 * GET /api/matching/mentors
 */
export const getMentorMatches = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        user_onboarding: { select: { wantToLearn: true, canTeach: true } },
      },
    });

    const wantToLearn = Array.isArray(currentUser?.user_onboarding?.wantToLearn)
      ? currentUser.user_onboarding.wantToLearn
      : [];

    const [existingConnections, blockedUserIds] = await Promise.all([
      prisma.connections.findMany({
        where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { requesterId: true, addresseeId: true },
      }),
      getBlockedUserIds(userId),
    ]);
    const excludeIds = new Set<string>([
      userId,
      ...existingConnections.flatMap((c) => [c.requesterId, c.addresseeId]),
      ...blockedUserIds,
    ]);

    const users = await prisma.user.findMany({
      where: {
        id: { notIn: Array.from(excludeIds) },
        isBanned: false,
        ...(wantToLearn.length > 0
          ? {
              OR: wantToLearn.map((skill: string) => ({
                skills: { some: { skill: { name: { contains: skill, mode: 'insensitive' } } } },
              })),
            }
          : {}),
      },
      take: 20,
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
        isVerified: true,
        profileBadgeStyle: true,
        college: true,
        graduationYear: true,
        user_onboarding: { select: { canTeach: true } },
        skills: { select: { skill: { select: { name: true } } } },
        userStats: { select: { xp: true, level: true } },
      },
    });

    const visibilityByUser = await getPremiumVisibilityByUserIds(users.map((user) => user.id));
    const mentors = sortByPremiumVisibility(users, visibilityByUser).map((rawUser) => {
      const u = applyPremiumVisibilityToUser(rawUser, visibilityByUser);
      const uo = u.user_onboarding;
      const userSkills = u.skills?.map((s: { skill: { name: string } }) => s.skill.name) ?? [];
      const teachableSkills = Array.isArray(uo?.canTeach) ? uo.canTeach : userSkills;
      return {
        user: {
          id: u.id,
          name: u.name,
          username: u.username,
          profileImage: u.profileImage,
          headline: u.headline,
          verified: Boolean(u.isVerified),
          isVerified: Boolean(u.isVerified),
          profileBadgeStyle: u.profileBadgeStyle ?? null,
          isPremium: u.isPremium,
          profileBoostActive: u.profileBoostActive,
          profileBoostEndsAt: u.profileBoostEndsAt,
          profileBoostPriority: u.profileBoostPriority,
          discoveryPriority: u.discoveryPriority,
          college: u.college,
          graduationYear: u.graduationYear,
        },
        teachableSkills,
        xp: (u as { userStats?: { xp: number; level: number } })?.userStats?.xp ?? 0,
        level: (u as { userStats?: { xp: number; level: number } })?.userStats?.level ?? 1,
      };
    });

    res.status(200).json({ mentors });
  } catch (error) {
    console.error('Error fetching mentor matches:', error);
    res.status(500).json({ error: 'Failed to fetch mentor matches' });
  }
};

/**
 * Get accountability partner matches (same goal)
 * GET /api/matching/accountability
 */
export const getAccountabilityMatches = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { user_onboarding: { select: { primaryGoal: true } } },
    });
    const myGoal = currentUser?.user_onboarding?.primaryGoal ?? undefined;

    const [existingConnections, blockedUserIds] = await Promise.all([
      prisma.connections.findMany({
        where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
        select: { requesterId: true, addresseeId: true },
      }),
      getBlockedUserIds(userId),
    ]);
    const excludeIds = new Set<string>([
      userId,
      ...existingConnections.flatMap((c) => [c.requesterId, c.addresseeId]),
      ...blockedUserIds,
    ]);

    const users = await prisma.user.findMany({
      where: {
        id: { notIn: Array.from(excludeIds) },
        isBanned: false,
        ...(myGoal
          ? { user_onboarding: { is: { primaryGoal: myGoal } } }
          : {}),
      },
      take: 20,
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
        isVerified: true,
        profileBadgeStyle: true,
        college: true,
        user_onboarding: { select: { primaryGoal: true } },
      },
    });

    const visibilityByUser = await getPremiumVisibilityByUserIds(users.map((user) => user.id));
    const matches = sortByPremiumVisibility(users, visibilityByUser).map((rawUser) => {
      const u = applyPremiumVisibilityToUser(rawUser, visibilityByUser);
      const uo = u.user_onboarding;
      return {
        user: {
          id: u.id,
          name: u.name,
          username: u.username,
          profileImage: u.profileImage,
          headline: u.headline,
          verified: Boolean(u.isVerified),
          isVerified: Boolean(u.isVerified),
          profileBadgeStyle: u.profileBadgeStyle ?? null,
          isPremium: u.isPremium,
          profileBoostActive: u.profileBoostActive,
          profileBoostEndsAt: u.profileBoostEndsAt,
          profileBoostPriority: u.profileBoostPriority,
          discoveryPriority: u.discoveryPriority,
          college: u.college,
        },
        sharedGoal: (uo?.primaryGoal as string) || null,
        availability: null,
      };
    });

    res.status(200).json({ matches });
  } catch (error) {
    console.error('Error fetching accountability matches:', error);
    res.status(500).json({ error: 'Failed to fetch accountability matches' });
  }
};

/**
 * Get ice breakers for a target user
 * GET /api/matching/ice-breakers/:targetUserId
 */
export const getIceBreakers = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const targetUserId = req.params.targetUserId;
    if (!targetUserId) {
      res.status(400).json({ error: 'Target user ID required' });
      return;
    }

    const [currentUser, targetUser] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          interests: true,
          college: true,
          user_onboarding: { select: { primaryGoal: true } },
        },
      }),
      prisma.user.findUnique({
        where: { id: targetUserId },
        select: {
          interests: true,
          college: true,
          user_onboarding: { select: { primaryGoal: true } },
        },
      }),
    ]);

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const myInterests = Array.isArray(currentUser?.interests) ? currentUser.interests : [];
    const theirInterests = Array.isArray(targetUser.interests) ? targetUser.interests : [];
    const sharedInterests = myInterests.filter((i) => theirInterests.includes(i));
    const sameCampus = !!(currentUser?.college && targetUser.college && currentUser.college === targetUser.college);
    const myGoal = currentUser?.user_onboarding?.primaryGoal;
    const theirGoal = targetUser.user_onboarding?.primaryGoal;
    const sharedGoal = !!(myGoal && theirGoal && myGoal === theirGoal);

    const iceBreakers: string[] = [];
    if (sharedInterests.length > 0) {
      iceBreakers.push(`You both love ${sharedInterests.slice(0, 2).join(' and ')}`);
    }
    if (sameCampus) {
      iceBreakers.push(`You're both at ${targetUser.college}`);
    }
    if (sharedGoal) {
      iceBreakers.push(`You share the same goal: ${theirGoal}`);
    }
    if (iceBreakers.length === 0) {
      iceBreakers.push(`Hi! I'd love to connect and learn more about what you're working on.`);
    }

    res.status(200).json({
      iceBreakers,
      actions: [
        { type: 'connect', label: 'Send connection request', icon: 'user-plus' },
        { type: 'message', label: 'Send a message', icon: 'message-circle' },
      ],
      context: {
        sharedInterests,
        sameCampus,
        sharedGoal,
      },
    });
  } catch (error) {
    console.error('Error fetching ice breakers:', error);
    res.status(500).json({ error: 'Failed to fetch ice breakers' });
  }
};
