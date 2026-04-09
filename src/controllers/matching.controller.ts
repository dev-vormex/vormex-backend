// @ts-nocheck
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';

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

    const type = (req.query.type as string) || 'all';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        college: true,
        branch: true,
        interests: true,
        graduationYear: true,
        user_onboarding: {
          select: { primaryGoal: true, wantToLearn: true, canTeach: true, lookingFor: true },
        },
      },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const uo = currentUser.user_onboarding;
    const myPrimaryGoal = uo?.primaryGoal ?? undefined;
    const myLookingFor = Array.isArray(uo?.lookingFor) ? uo.lookingFor : [];
    const myWantToLearn = Array.isArray(uo?.wantToLearn) ? uo.wantToLearn : [];
    const myCanTeach = Array.isArray(uo?.canTeach) ? uo.canTeach : [];

    const existingConnections = await prisma.connections.findMany({
      where: {
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const excludeIds = new Set([userId]);
    existingConnections.forEach((c) => {
      excludeIds.add(c.requesterId);
      excludeIds.add(c.addresseeId);
    });

    const where: any = {
      id: { notIn: Array.from(excludeIds) },
      isBanned: false,
    };

    if (type === 'same_campus' && currentUser.college) {
      where.college = currentUser.college;
    }

    const [allUsers, totalCount] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: 0,
        take: Math.min(limit * 3, 150),
        orderBy: { lastActiveAt: 'desc' },
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          headline: true,
          college: true,
          branch: true,
          graduationYear: true,
          interests: true,
          bio: true,
          githubConnected: true,
          user_onboarding: {
            select: { primaryGoal: true, wantToLearn: true, canTeach: true, lookingFor: true },
          },
          lastActiveAt: true,
          skills: { select: { skill: { select: { name: true } }, proficiency: true } },
          userStats: {
            select: { connectionsCount: true, xp: true, level: true },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    let filteredUsers = allUsers;
    if (type === 'same_goal' && myPrimaryGoal) {
      filteredUsers = allUsers.filter((u) => u.user_onboarding?.primaryGoal === myPrimaryGoal);
    } else if (type === 'mentor' && myWantToLearn.length > 0) {
      filteredUsers = allUsers.filter((u) => {
        const canTeach = Array.isArray(u.user_onboarding?.canTeach) ? u.user_onboarding.canTeach : [];
        return myWantToLearn.some((s) => canTeach.some((t) => t?.toLowerCase().includes(s.toLowerCase())));
      });
    } else if (type === 'mentee' && myCanTeach.length > 0) {
      filteredUsers = allUsers.filter((u) => {
        const wantToLearn = Array.isArray(u.user_onboarding?.wantToLearn) ? u.user_onboarding.wantToLearn : [];
        return myCanTeach.some((s) => wantToLearn.some((t) => t?.toLowerCase().includes(s.toLowerCase())));
      });
    }

    const total = type === 'all' || type === 'same_campus' ? totalCount : filteredUsers.length;
    const paginatedUsers = filteredUsers.slice(skip, skip + limit);

    const matches = paginatedUsers.map((user) => {
      const od = user.user_onboarding || {};
      let score = 0;
      const reasons: string[] = [];

      if (currentUser.college && user.college === currentUser.college) {
        score += 25;
        reasons.push('Same college');
      }
      if (currentUser.branch && user.branch === currentUser.branch) {
        score += 15;
        reasons.push('Same branch');
      }
      if (currentUser.interests && user.interests) {
        const overlap = user.interests.filter((i) => currentUser.interests?.includes(i)).length;
        score += overlap * 10;
        if (overlap > 0) reasons.push(`${overlap} shared interest${overlap > 1 ? 's' : ''}`);
      }
      if (myPrimaryGoal && od.primaryGoal === myPrimaryGoal) {
        score += 20;
        reasons.push('Same goal');
      }
      if (user.lastActiveAt && new Date(user.lastActiveAt) > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
        score += 5;
        reasons.push('Recently active');
      }

      const matchPercentage = Math.min(100, score);
      const tags = [...reasons];

      return {
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          profileImage: user.profileImage,
          headline: user.headline,
          college: user.college,
          branch: user.branch,
          graduationYear: user.graduationYear,
          interests: user.interests || [],
          bio: user.bio,
          githubConnected: user.githubConnected,
          skills: user.skills.map((s) => s.skill.name),
          onboarding: myPrimaryGoal || od.primaryGoal
            ? {
                primaryGoal: od.primaryGoal || null,
                lookingFor: Array.isArray(od.lookingFor) ? od.lookingFor : [],
              }
            : null,
          stats: user.userStats
            ? {
                connectionsCount: user.userStats.connectionsCount,
                xp: user.userStats.xp,
                level: user.userStats.level,
              }
            : null,
        },
        score,
        matchPercentage,
        reasons,
        tags,
      };
    });

    res.status(200).json({
      matches,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
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

    const existingConnections = await prisma.connections.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      select: { requesterId: true, addresseeId: true },
    });
    const excludeIds = new Set<string>([userId, ...existingConnections.flatMap((c) => [c.requesterId, c.addresseeId])]);

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
        college: true,
        graduationYear: true,
        user_onboarding: { select: { canTeach: true } },
        skills: { select: { skill: { select: { name: true } } } },
        userStats: { select: { xp: true, level: true } },
      },
    });

    const mentors = users.map((u) => {
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

    const existingConnections = await prisma.connections.findMany({
      where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      select: { requesterId: true, addresseeId: true },
    });
    const excludeIds = new Set<string>([userId, ...existingConnections.flatMap((c) => [c.requesterId, c.addresseeId])]);

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
        college: true,
        user_onboarding: { select: { primaryGoal: true } },
      },
    });

    const matches = users.map((u) => {
      const uo = u.user_onboarding;
      return {
        user: {
          id: u.id,
          name: u.name,
          username: u.username,
          profileImage: u.profileImage,
          headline: u.headline,
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
