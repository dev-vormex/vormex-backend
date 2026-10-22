import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { AuthRequest, parseStringArray, buildUserAudienceWhere, mapAdminUser } from "./support.controller";

// ============================================
// USERS
// ============================================

export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const status = req.query.status as string;
    const excludeBanned = String(req.query.excludeBanned || '').toLowerCase() === 'true';
    const hasActivePushToken =
      typeof req.query.hasActivePushToken === 'string'
        ? req.query.hasActivePushToken.toLowerCase() === 'true'
        : undefined;
    const colleges = parseStringArray(req.query.college);
    const skills = parseStringArray(req.query.skill);
    const sortBy = (req.query.sortBy as string) || 'createdAt';
    const sortOrder = (req.query.sortOrder as string) || 'desc';
    const skip = (page - 1) * limit;

    const where: any = buildUserAudienceWhere({
      search,
      colleges,
      skills,
      excludeBanned,
    });

    if (status === 'verified') where.isVerified = true;
    else if (status === 'unverified') where.isVerified = false;
    else if (status === 'banned') where.isBanned = true;
    if (hasActivePushToken === true) {
      where.device_tokens = {
        some: {
          isActive: true,
        },
      };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          profileImage: true,
          college: true,
          branch: true,
          graduationYear: true,
          isVerified: true,
          isBanned: true,
          isAdmin: true,
          role: true,
          createdAt: true,
          lastActiveAt: true,
          isOnline: true,
          authProvider: true,
          profileTheme: true,
          device_tokens: {
            where: {
              isActive: true,
            },
            orderBy: { updatedAt: 'desc' },
            take: 3,
            select: {
              platform: true,
              updatedAt: true,
            },
          },
          skills: {
            select: {
              skill: {
                select: {
                  name: true,
                },
              },
            },
            take: 8,
          },
          _count: {
            select: {
              posts: true,
              connections_connections_requesterIdTousers: true,
              connections_connections_addresseeIdTousers: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const mappedUsers = users.map(mapAdminUser);

    res.json({
      users: mappedUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getUsers error:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
};

export const getUserById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        _count: {
          select: {
            posts: true,
            connections_connections_requesterIdTousers: true,
            connections_connections_addresseeIdTousers: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { password, resetToken, resetTokenExpiry, verificationToken, verificationTokenExpiry, adminTwoFactorSecret, ...safeUser } = user;

    res.json({ user: safeUser });
  } catch (error) {
    console.error('getUserById error:', error);
    res.status(500).json({ error: 'Failed to load user' });
  }
};
