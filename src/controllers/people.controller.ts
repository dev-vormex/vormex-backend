import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';

interface PersonCard {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  bannerImageUrl: string | null;
  headline: string | null;
  college: string | null;
  branch: string | null;
  bio: string | null;
  skills: string[];
  interests: string[];
  isOnline: boolean;
  connectionStatus: 'none' | 'pending_sent' | 'pending_received' | 'connected';
  mutualConnections?: number;
}

interface PeopleResponse {
  people: PersonCard[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
}

interface FilterOptions {
  colleges: string[];
  branches: string[];
  graduationYears: number[];
  locations: string[];
}

const getConnectionStatus = async (
  currentUserId: string,
  targetUserId: string
): Promise<'none' | 'pending_sent' | 'pending_received' | 'connected'> => {
  const connection = await prisma.connections.findFirst({
    where: {
      OR: [
        { requesterId: currentUserId, addresseeId: targetUserId },
        { requesterId: targetUserId, addresseeId: currentUserId },
      ],
    },
  });

  if (!connection) return 'none';
  if (connection.status === 'accepted') return 'connected';
  if (connection.status === 'pending') {
    return connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received';
  }
  return 'none';
};

const getMutualConnectionsCount = async (
  userId1: string,
  userId2: string
): Promise<number> => {
  const user1Connections = await prisma.connections.findMany({
    where: {
      OR: [
        { requesterId: userId1, status: 'accepted' },
        { addresseeId: userId1, status: 'accepted' },
      ],
    },
    select: { requesterId: true, addresseeId: true },
  });

  const user1ConnectionIds = new Set(
    user1Connections.map((c) =>
      c.requesterId === userId1 ? c.addresseeId : c.requesterId
    )
  );

  const user2Connections = await prisma.connections.findMany({
    where: {
      OR: [
        { requesterId: userId2, status: 'accepted' },
        { addresseeId: userId2, status: 'accepted' },
      ],
    },
    select: { requesterId: true, addresseeId: true },
  });

  let mutualCount = 0;
  for (const c of user2Connections) {
    const connectedUserId = c.requesterId === userId2 ? c.addresseeId : c.requesterId;
    if (user1ConnectionIds.has(connectedUserId)) {
      mutualCount++;
    }
  }

  return mutualCount;
};

/**
 * Get people with filters and pagination
 * GET /api/people
 */
export const getPeople = async (
  req: AuthenticatedRequest,
  res: Response<PeopleResponse | ErrorResponse>
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const {
      search,
      college,
      branch,
      graduationYear,
      skills,
      interests,
      location,
      isOpenToOpportunities,
    } = req.query;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (userId) {
      where.id = { not: userId };
    }

    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
        { headline: { contains: search, mode: 'insensitive' } },
        { bio: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (college && typeof college === 'string') {
      where.college = { contains: college, mode: 'insensitive' };
    }

    if (branch && typeof branch === 'string') {
      where.branch = { contains: branch, mode: 'insensitive' };
    }

    if (graduationYear) {
      where.graduationYear = parseInt(graduationYear as string);
    }

    if (skills && typeof skills === 'string') {
      const skillList = skills.split(',').map((s) => s.trim().toLowerCase());
      where.skills = {
        some: {
          skill: {
            name: { in: skillList, mode: 'insensitive' },
          },
        },
      };
    }

    if (interests && typeof interests === 'string') {
      const interestList = interests.split(',').map((i) => i.trim());
      where.interests = { hasSome: interestList };
    }

    if (location && typeof location === 'string') {
      where.location = { contains: location, mode: 'insensitive' };
    }

    if (isOpenToOpportunities === 'true') {
      where.isOpenToOpportunities = true;
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { lastActiveAt: 'desc' },
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          bannerImageUrl: true,
          headline: true,
          college: true,
          branch: true,
          bio: true,
          interests: true,
          isOnline: true,
          skills: {
            select: { skill: { select: { name: true } } },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const targetIds = users.map((user) => user.id);
    const targetIdSet = new Set(targetIds);
    const connectionStatusByUser = new Map<string, PersonCard['connectionStatus']>();
    const mutualConnectionsByUser = new Map<string, number>();

    if (userId && targetIds.length > 0) {
      const [directConnections, currentUserConnections] = await Promise.all([
        prisma.connections.findMany({
          where: {
            OR: [
              { requesterId: userId, addresseeId: { in: targetIds } },
              { requesterId: { in: targetIds }, addresseeId: userId },
            ],
          },
          select: { requesterId: true, addresseeId: true, status: true },
        }),
        prisma.connections.findMany({
          where: {
            status: 'accepted',
            OR: [
              { requesterId: userId },
              { addresseeId: userId },
            ],
          },
          select: { requesterId: true, addresseeId: true },
        }),
      ]);

      for (const connection of directConnections) {
        const targetUserId = connection.requesterId === userId
          ? connection.addresseeId
          : connection.requesterId;
        if (connection.status === 'accepted') {
          connectionStatusByUser.set(targetUserId, 'connected');
        } else if (connection.status === 'pending') {
          connectionStatusByUser.set(
            targetUserId,
            connection.requesterId === userId ? 'pending_sent' : 'pending_received'
          );
        }
      }

      const currentConnectionIds = Array.from(new Set(
        currentUserConnections.map((connection) =>
          connection.requesterId === userId ? connection.addresseeId : connection.requesterId
        )
      ));

      if (currentConnectionIds.length > 0) {
        const mutualRows = await prisma.connections.findMany({
          where: {
            status: 'accepted',
            OR: [
              { requesterId: { in: targetIds }, addresseeId: { in: currentConnectionIds } },
              { requesterId: { in: currentConnectionIds }, addresseeId: { in: targetIds } },
            ],
          },
          select: { requesterId: true, addresseeId: true },
        });

        const mutualSetsByUser = new Map<string, Set<string>>();
        for (const connection of mutualRows) {
          const targetUserId = targetIdSet.has(connection.requesterId)
            ? connection.requesterId
            : targetIdSet.has(connection.addresseeId)
              ? connection.addresseeId
              : null;
          if (!targetUserId) continue;

          const mutualUserId = connection.requesterId === targetUserId
            ? connection.addresseeId
            : connection.requesterId;
          const mutualSet = mutualSetsByUser.get(targetUserId) || new Set<string>();
          mutualSet.add(mutualUserId);
          mutualSetsByUser.set(targetUserId, mutualSet);
        }

        for (const [targetUserId, mutualSet] of mutualSetsByUser) {
          mutualConnectionsByUser.set(targetUserId, mutualSet.size);
        }
      }
    }

    const people: PersonCard[] = users.map((user) => ({
      id: user.id,
      username: user.username,
      name: user.name,
      profileImage: user.profileImage,
      bannerImageUrl: user.bannerImageUrl,
      headline: user.headline,
      college: user.college,
      branch: user.branch,
      bio: user.bio,
      skills: user.skills.map((s) => s.skill.name),
      interests: user.interests,
      isOnline: user.isOnline,
      connectionStatus: connectionStatusByUser.get(user.id) || 'none',
      mutualConnections: mutualConnectionsByUser.get(user.id) || 0,
    }));

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      people,
      total,
      page,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (error) {
    console.error('Error fetching people:', error);
    res.status(500).json({
      error: 'Failed to fetch people',
    });
  }
};

/**
 * Get personalized suggestions
 * GET /api/people/suggestions
 */
export const getSuggestions = async (
  req: AuthenticatedRequest,
  res: Response<{ suggestions: PersonCard[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || 10));

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { college: true, branch: true, interests: true, graduationYear: true },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

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

    const users = await prisma.user.findMany({
      where: {
        id: { notIn: Array.from(excludeIds) },
        OR: [
          { college: currentUser.college },
          { branch: currentUser.branch },
          { interests: { hasSome: currentUser.interests } },
          { graduationYear: currentUser.graduationYear },
        ],
      },
      take: limit,
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        college: true,
        branch: true,
        bio: true,
        interests: true,
        isOnline: true,
        skills: {
          select: { skill: { select: { name: true } } },
        },
      },
    });

    const suggestions: PersonCard[] = await Promise.all(
      users.map(async (user) => {
        const mutualConnections = await getMutualConnectionsCount(userId, user.id);
        return {
          id: user.id,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
          bannerImageUrl: user.bannerImageUrl,
          headline: user.headline,
          college: user.college,
          branch: user.branch,
          bio: user.bio,
          skills: user.skills.map((s) => s.skill.name),
          interests: user.interests,
          isOnline: user.isOnline,
          connectionStatus: 'none',
          mutualConnections,
        };
      })
    );

    res.status(200).json({ suggestions });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
};

/**
 * Get people from same college
 * GET /api/people/same-college
 */
export const getPeopleFromSameCollege = async (
  req: AuthenticatedRequest,
  res: Response<{ people: PersonCard[]; userCollege?: string | null } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || 10));

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { college: true },
    });

    if (!currentUser || !currentUser.college) {
      res.status(200).json({ people: [], userCollege: null });
      return;
    }

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        college: currentUser.college,
      },
      take: limit,
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        college: true,
        branch: true,
        bio: true,
        interests: true,
        isOnline: true,
        skills: {
          select: { skill: { select: { name: true } } },
        },
      },
    });

    const people: PersonCard[] = await Promise.all(
      users.map(async (user) => {
        const connectionStatus = await getConnectionStatus(userId, user.id);
        const mutualConnections = await getMutualConnectionsCount(userId, user.id);
        return {
          id: user.id,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
          bannerImageUrl: user.bannerImageUrl,
          headline: user.headline,
          college: user.college,
          branch: user.branch,
          bio: user.bio,
          skills: user.skills.map((s) => s.skill.name),
          interests: user.interests,
          isOnline: user.isOnline,
          connectionStatus,
          mutualConnections,
        };
      })
    );

    res.status(200).json({ people, userCollege: currentUser.college });
  } catch (error) {
    console.error('Error fetching same college people:', error);
    res.status(500).json({ error: 'Failed to fetch people from same college' });
  }
};

/**
 * Search colleges on the platform
 * GET /api/people/colleges?q=search_term
 * Returns unique college names from all users
 */
export const searchColleges = async (
  req: AuthenticatedRequest,
  res: Response<{ colleges: { name: string; count: number }[] } | ErrorResponse>
): Promise<void> => {
  try {
    const query = (req.query.q as string || '').trim().toLowerCase();
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || 10));

    // Get all distinct colleges with count
    const collegeData = await prisma.user.groupBy({
      by: ['college'],
      where: {
        college: {
          not: null,
          ...(query ? { contains: query, mode: 'insensitive' } : {}),
        },
      },
      _count: {
        college: true,
      },
      orderBy: {
        _count: {
          college: 'desc',
        },
      },
      take: limit,
    });

    const colleges = collegeData
      .filter((c) => c.college !== null)
      .map((c) => ({
        name: c.college!,
        count: c._count.college,
      }));

    res.status(200).json({ colleges });
  } catch (error) {
    console.error('Error searching colleges:', error);
    res.status(500).json({ error: 'Failed to search colleges' });
  }
};

/**
 * Get people near the user
 * GET /api/people/near-me
 */
export const getPeopleNearMe = async (
  req: AuthenticatedRequest,
  res: Response<{ people: PersonCard[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit as string) || 10));

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { location: true, currentCity: true },
    });

    if (!currentUser || (!currentUser.location && !currentUser.currentCity)) {
      res.status(200).json({ people: [] });
      return;
    }

    const locationSearch = currentUser.currentCity || currentUser.location;

    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        OR: [
          { location: { contains: locationSearch || '', mode: 'insensitive' } },
          { currentCity: { contains: locationSearch || '', mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { lastActiveAt: 'desc' },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        college: true,
        branch: true,
        bio: true,
        interests: true,
        isOnline: true,
        skills: {
          select: { skill: { select: { name: true } } },
        },
      },
    });

    const people: PersonCard[] = await Promise.all(
      users.map(async (user) => {
        const connectionStatus = await getConnectionStatus(userId, user.id);
        const mutualConnections = await getMutualConnectionsCount(userId, user.id);
        return {
          id: user.id,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
          bannerImageUrl: user.bannerImageUrl,
          headline: user.headline,
          college: user.college,
          branch: user.branch,
          bio: user.bio,
          skills: user.skills.map((s) => s.skill.name),
          interests: user.interests,
          isOnline: user.isOnline,
          connectionStatus,
          mutualConnections,
        };
      })
    );

    res.status(200).json({ people });
  } catch (error) {
    console.error('Error fetching people near me:', error);
    res.status(500).json({ error: 'Failed to fetch nearby people' });
  }
};

/**
 * Get filter options
 * GET /api/people/filter-options
 */
export const getFilterOptions = async (
  req: AuthenticatedRequest,
  res: Response<FilterOptions | ErrorResponse>
): Promise<void> => {
  try {
    const [collegesResult, branchesResult, yearsResult, locationsResult] = await Promise.all([
      prisma.user.findMany({
        where: { college: { not: null } },
        select: { college: true },
        distinct: ['college'],
      }),
      prisma.user.findMany({
        where: { branch: { not: null } },
        select: { branch: true },
        distinct: ['branch'],
      }),
      prisma.user.findMany({
        where: { graduationYear: { not: null } },
        select: { graduationYear: true },
        distinct: ['graduationYear'],
        orderBy: { graduationYear: 'desc' },
      }),
      prisma.user.findMany({
        where: { location: { not: null } },
        select: { location: true },
        distinct: ['location'],
      }),
    ]);

    res.status(200).json({
      colleges: collegesResult.map((c) => c.college!).filter(Boolean).sort(),
      branches: branchesResult.map((b) => b.branch!).filter(Boolean).sort(),
      graduationYears: yearsResult.map((y) => y.graduationYear!).filter(Boolean),
      locations: locationsResult.map((l) => l.location!).filter(Boolean).sort(),
    });
  } catch (error) {
    console.error('Error fetching filter options:', error);
    res.status(500).json({ error: 'Failed to fetch filter options' });
  }
};
