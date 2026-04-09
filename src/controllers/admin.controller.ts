// @ts-nocheck
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { notificationService } from '../services/notification.service';
import { pushNotificationService } from '../services/push-notification.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const parseStringArray = (value: any): string[] => {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
};

const normalizeOptionalString = (value: any): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const buildUserAudienceWhere = ({
  search,
  colleges = [],
  skills = [],
  excludeBanned = true,
}: {
  search?: string;
  colleges?: string[];
  skills?: string[];
  excludeBanned?: boolean;
}) => {
  const where: any = {};

  if (excludeBanned) {
    where.isBanned = false;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } },
      { college: { contains: search, mode: 'insensitive' } },
      { branch: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (colleges.length > 0) {
    where.college = { in: colleges };
  }

  if (skills.length > 0) {
    where.skills = {
      some: {
        skill: {
          name: { in: skills },
        },
      },
    };
  }

  return where;
};

const mapAdminUser = (user: any) => ({
  ...user,
  skills: user.skills?.map((entry: any) => entry.skill.name) ?? [],
  _count: {
    posts: user._count.posts,
    connectionsSent: user._count.connections_connections_requesterIdTousers,
    connectionsReceived: user._count.connections_connections_addresseeIdTousers,
  },
});

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

// ============================================
// AUTH & VERIFY
// ============================================

export const verifyAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: String(req.user.userId) },
      select: {
        id: true,
        email: true,
        name: true,
        profileImage: true,
        role: true,
        isAdmin: true,
        adminTwoFactorEnabled: true,
      },
    });

    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required', isAdmin: false });
      return;
    }

    res.json({
      isAdmin: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profileImage: user.profileImage,
        role: user.role,
      },
      twoFactorEnabled: user.adminTwoFactorEnabled,
      requiresTwoFactor: !user.adminTwoFactorEnabled,
    });
  } catch (error) {
    console.error('verifyAdmin error:', error);
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
};

// ============================================
// 2FA (stub — returns success for now)
// ============================================

export const setup2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({
      secret: 'SETUP_NOT_IMPLEMENTED',
      qrCode: '',
      message: '2FA setup placeholder',
    });
  } catch (error) {
    console.error('setup2FA error:', error);
    res.status(500).json({ error: 'Failed to setup 2FA' });
  }
};

export const verify2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({ success: true, message: '2FA verified' });
  } catch (error) {
    console.error('verify2FA error:', error);
    res.status(500).json({ error: 'Failed to verify 2FA' });
  }
};

export const validate2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({ success: true, verified: true });
  } catch (error) {
    console.error('validate2FA error:', error);
    res.status(500).json({ error: 'Failed to validate 2FA' });
  }
};

// ============================================
// DASHBOARD STATS
// ============================================

export const getDashboardStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalPosts,
      totalGroups,
      totalConnections,
      totalMessages,
      activeUsersToday,
      newUsersToday,
      newUsersThisWeek,
      newUsersThisMonth,
      bannedUsers,
      verifiedUsers,
      recentSignups,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.post.count(),
      prisma.groups.count(),
      prisma.connections.count({ where: { status: 'accepted' } }),
      prisma.messages.count(),
      prisma.user.count({ where: { lastActiveAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.user.count({ where: { isVerified: true } }),
      prisma.user.findMany({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          profileImage: true,
          createdAt: true,
          isVerified: true,
          college: true,
        },
      }),
    ]);

    res.json({
      stats: {
        totalUsers,
        totalPosts,
        totalGroups,
        totalJobs: 0,
        totalCompanies: 0,
        totalConnections,
        totalMessages,
        activeUsersToday,
        newUsersToday,
        newUsersThisWeek,
        newUsersThisMonth,
        bannedUsers,
        verifiedUsers,
      },
      recentSignups,
    });
  } catch (error) {
    console.error('getDashboardStats error:', error);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
};

// ============================================
// NOTIFICATIONS
// ============================================

export const getNotificationAudienceFilters = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [collegeRows, skillRows] = await Promise.all([
      prisma.user.findMany({
        where: {
          college: {
            not: null,
          },
          isBanned: false,
        },
        select: { college: true },
        distinct: ['college'],
        orderBy: { college: 'asc' },
      }),
      prisma.skill.findMany({
        select: { name: true },
        orderBy: { name: 'asc' },
        take: 300,
      }),
    ]);

    res.json({
      colleges: collegeRows
        .map((row) => row.college)
        .filter((college): college is string => Boolean(college?.trim())),
      skills: skillRows
        .map((row) => row.name)
        .filter((skill) => Boolean(skill?.trim())),
    });
  } catch (error) {
    console.error('getNotificationAudienceFilters error:', error);
    res.status(500).json({ error: 'Failed to load notification filters' });
  }
};

export const sendAdminNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const title = normalizeOptionalString(req.body?.title);
    const body = normalizeOptionalString(req.body?.body);
    const audience = normalizeOptionalString(req.body?.audience) || 'all';
    const search = normalizeOptionalString(req.body?.search);
    const colleges = parseStringArray(req.body?.colleges);
    const skills = parseStringArray(req.body?.skills);
    const userIds = [...new Set(parseStringArray(req.body?.userIds))];

    if (!title) {
      res.status(400).json({ error: 'Notification title is required' });
      return;
    }

    if (!body) {
      res.status(400).json({ error: 'Notification description is required' });
      return;
    }

    if (title.length > 120) {
      res.status(400).json({ error: 'Notification title must be 120 characters or less' });
      return;
    }

    if (body.length > 500) {
      res.status(400).json({ error: 'Notification description must be 500 characters or less' });
      return;
    }

    let recipients: Array<{ id: string; name: string; username: string }> = [];

    if (audience === 'specific') {
      if (userIds.length === 0) {
        res.status(400).json({ error: 'Select at least one user for a specific notification' });
        return;
      }

      recipients = await prisma.user.findMany({
        where: {
          id: { in: userIds },
          isBanned: false,
        },
        select: {
          id: true,
          name: true,
          username: true,
        },
      });
    } else {
      const where =
        audience === 'filtered'
          ? buildUserAudienceWhere({ search, colleges, skills, excludeBanned: true })
          : { isBanned: false };

      recipients = await prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          username: true,
        },
      });
    }

    if (recipients.length === 0) {
      res.status(400).json({ error: 'No matching users found for this notification audience' });
      return;
    }

    const notificationData = {
      senderType: 'admin',
      branding: 'vormex',
      source: 'admin_panel',
      adminId: String(req.user.userId),
      screen: 'engagement',
    };

    const recipientIds = recipients.map((recipient) => recipient.id);
    for (const batch of chunkArray(recipientIds, 25)) {
      await Promise.all(
        batch.map((userId) =>
          notificationService.notifyAdminAnnouncement(userId, title, body, notificationData)
        )
      );
    }

    const pushSuccessCount = await pushNotificationService.pushAdminAnnouncement(
      recipientIds,
      title,
      body,
      {
        adminId: String(req.user.userId),
      }
    );

    res.json({
      message: 'Notification sent successfully',
      recipientsCount: recipients.length,
      pushSuccessCount,
      recipientsPreview: recipients.slice(0, 10),
    });
  } catch (error) {
    console.error('sendAdminNotification error:', error);
    res.status(500).json({ error: 'Failed to send admin notification' });
  }
};

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

export const updateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const allowedFields = ['name', 'email', 'role', 'isVerified', 'college', 'branch', 'graduationYear'];
    const data: any = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data,
    });

    res.json({ user, message: 'User updated successfully' });
  } catch (error) {
    console.error('updateUser error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

export const banUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    if (id === String(req.user.userId)) {
      res.status(400).json({ error: 'Cannot ban yourself' });
      return;
    }

    await prisma.user.update({
      where: { id },
      data: { isBanned: true },
    });

    res.json({ message: 'User banned successfully' });
  } catch (error) {
    console.error('banUser error:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
};

export const unbanUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.user.update({
      where: { id: req.params.id },
      data: { isBanned: false },
    });

    res.json({ message: 'User unbanned successfully' });
  } catch (error) {
    console.error('unbanUser error:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
};

export const verifyUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.user.update({
      where: { id: req.params.id },
      data: { isVerified: true },
    });

    res.json({ message: 'User verified successfully' });
  } catch (error) {
    console.error('verifyUser error:', error);
    res.status(500).json({ error: 'Failed to verify user' });
  }
};

export const deleteUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    if (id === String(req.user.userId)) {
      res.status(400).json({ error: 'Cannot delete yourself' });
      return;
    }

    await prisma.user.delete({ where: { id } });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('deleteUser error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

// ============================================
// POSTS
// ============================================

export const getPosts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const type = req.query.type as string;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.content = { contains: search, mode: 'insensitive' };
    }
    if (type && type !== 'all') {
      where.type = type;
    }

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          content: true,
          mediaUrls: true,
          likesCount: true,
          commentsCount: true,
          createdAt: true,
          author: {
            select: {
              id: true,
              name: true,
              username: true,
              profileImage: true,
            },
          },
        },
      }),
      prisma.post.count({ where }),
    ]);

    res.json({
      posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getPosts error:', error);
    res.status(500).json({ error: 'Failed to load posts' });
  }
};

export const deletePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.post.delete({ where: { id: req.params.id } });

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('deletePost error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
};

// ============================================
// REELS
// ============================================

export const getReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [reels, total] = await Promise.all([
      prisma.reels.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          videoUrl: true,
          thumbnailUrl: true,
          caption: true,
          viewsCount: true,
          likesCount: true,
          commentsCount: true,
          createdAt: true,
          users: {
            select: {
              id: true,
              name: true,
              username: true,
              profileImage: true,
            },
          },
        },
      }),
      prisma.reels.count(),
    ]);

    const mappedReels = reels.map((r) => ({
      ...r,
      author: r.users,
      users: undefined,
    }));

    res.json({
      reels: mappedReels,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getReels error:', error);
    res.status(500).json({ error: 'Failed to load reels' });
  }
};

export const deleteReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.reels.delete({ where: { id: req.params.id } });

    res.json({ message: 'Reel deleted successfully' });
  } catch (error) {
    console.error('deleteReel error:', error);
    res.status(500).json({ error: 'Failed to delete reel' });
  }
};

// ============================================
// GROUPS
// ============================================

export const getGroups = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const [groups, total] = await Promise.all([
      prisma.groups.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          isPrivate: true,
          coverImage: true,
          memberCount: true,
          createdAt: true,
          users: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
          _count: {
            select: {
              group_members: true,
              group_messages: true,
            },
          },
        },
      }),
      prisma.groups.count({ where }),
    ]);

    const mappedGroups = groups.map((g) => ({
      ...g,
      privacy: g.isPrivate ? 'private' : 'public',
      createdBy: g.users,
      users: undefined,
      _count: {
        members: g._count.group_members,
        posts: g._count.group_messages,
      },
    }));

    res.json({
      groups: mappedGroups,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getGroups error:', error);
    res.status(500).json({ error: 'Failed to load groups' });
  }
};

export const deleteGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.groups.delete({ where: { id: req.params.id } });

    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    console.error('deleteGroup error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
};

// ============================================
// REPORTS
// ============================================

const reportUserSelect = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  email: true,
  isBanned: true,
} as const;

const moderationReportInclude = {
  reporter: { select: reportUserSelect },
  reportedUser: { select: reportUserSelect },
  reviewerUser: { select: reportUserSelect },
  conversation: {
    include: {
      users_conversations_participant1IdTousers: {
        select: { id: true, name: true, username: true, profileImage: true },
      },
      users_conversations_participant2IdTousers: {
        select: { id: true, name: true, username: true, profileImage: true },
      },
    },
  },
} as const;

function mapUserToReportUser(u: any) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    profileImage: u.profileImage,
    email: u.email,
    isBanned: u.isBanned,
  };
}

function mapModerationReportToAdmin(row: any) {
  return {
    id: row.id,
    reportType: row.reportType,
    reason: row.reason,
    description: row.description,
    status: row.status,
    priority: row.priority,
    actionTaken: row.actionTaken,
    adminNotes: row.adminNotes,
    chatMessages: null,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reporter: mapUserToReportUser(row.reporter),
    reportedUser: mapUserToReportUser(row.reportedUser),
    post: null,
    comment: null,
    conversation: row.conversation
      ? {
          id: row.conversation.id,
          participant1: mapUserToReportUser(row.conversation.users_conversations_participant1IdTousers),
          participant2: mapUserToReportUser(row.conversation.users_conversations_participant2IdTousers),
        }
      : null,
    group: null,
    reviewedBy: mapUserToReportUser(row.reviewerUser),
  };
}

export const getReports = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    const search = normalizeOptionalString(req.query.search);

    const where: any = {};
    if (status && status !== 'all') where.status = status;
    if (type && type !== 'all') where.reportType = type;
    if (search) {
      where.OR = [
        { reason: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { reporter: { name: { contains: search, mode: 'insensitive' } } },
        { reporter: { username: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total, statusAgg] = await Promise.all([
      prisma.moderation_reports.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: moderationReportInclude,
      }),
      prisma.moderation_reports.count({ where }),
      prisma.moderation_reports.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const statusCounts = { PENDING: 0, UNDER_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 };
    for (const s of statusAgg) {
      const key = s.status as keyof typeof statusCounts;
      if (key in statusCounts) statusCounts[key] = s._count._all;
    }

    res.json({
      reports: rows.map(mapModerationReportToAdmin),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
      statusCounts,
    });
  } catch (error) {
    console.error('getReports error:', error);
    res.status(500).json({ error: 'Failed to load reports' });
  }
};

export const getReportStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [total, pending, underReview, resolved] = await Promise.all([
      prisma.moderation_reports.count(),
      prisma.moderation_reports.count({ where: { status: 'PENDING' } }),
      prisma.moderation_reports.count({ where: { status: 'UNDER_REVIEW' } }),
      prisma.moderation_reports.count({ where: { status: 'RESOLVED' } }),
    ]);
    res.json({ total, pending, underReview, resolved });
  } catch (error) {
    console.error('getReportStats error:', error);
    res.status(500).json({ error: 'Failed to load report stats' });
  }
};

export const getReportById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const row = await prisma.moderation_reports.findUnique({
      where: { id },
      include: moderationReportInclude,
    });
    if (!row) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    res.json({ report: mapModerationReportToAdmin(row), previousReports: [] });
  } catch (error) {
    console.error('getReportById error:', error);
    res.status(500).json({ error: 'Failed to load report' });
  }
};

export const updateReportStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || typeof status !== 'string') {
      res.status(400).json({ error: 'status required' });
      return;
    }
    const updated = await prisma.moderation_reports.update({
      where: { id },
      data: { status },
      include: moderationReportInclude,
    });
    res.json({ message: 'Updated', report: mapModerationReportToAdmin(updated) });
  } catch (error) {
    console.error('updateReportStatus error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
};

export const updateReportPriority = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const priority = parseInt(String(req.body?.priority), 10);
    if (Number.isNaN(priority)) {
      res.status(400).json({ error: 'priority required' });
      return;
    }
    const updated = await prisma.moderation_reports.update({
      where: { id },
      data: { priority },
      include: moderationReportInclude,
    });
    res.json({ message: 'Updated', report: mapModerationReportToAdmin(updated) });
  } catch (error) {
    console.error('updateReportPriority error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
};

export const takeReportAction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const { action, adminNotes, banReason } = req.body ?? {};

    const report = await prisma.moderation_reports.findUnique({ where: { id } });
    if (!report) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (action === 'USER_BANNED' && report.reportedUserId && report.reportedUserId !== adminId) {
        await tx.user.update({
          where: { id: report.reportedUserId },
          data: { isBanned: true },
        });
      }
      await tx.moderation_reports.update({
        where: { id },
        data: {
          actionTaken: typeof action === 'string' ? action : 'NONE',
          adminNotes: typeof adminNotes === 'string' ? adminNotes : null,
          banReason: typeof banReason === 'string' ? banReason : null,
          status: 'RESOLVED',
          reviewedById: adminId,
          reviewedAt: new Date(),
        },
      });
    });

    const updated = await prisma.moderation_reports.findUnique({
      where: { id },
      include: moderationReportInclude,
    });
    res.json({
      message: 'Action recorded',
      report: mapModerationReportToAdmin(updated),
      actionResults: {},
    });
  } catch (error) {
    console.error('takeReportAction error:', error);
    res.status(500).json({ error: 'Failed to take action' });
  }
};

// ============================================
// AUDIT LOGS (stub — no AuditLog model yet)
// ============================================

export const getAuditLogs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      logs: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  } catch (error) {
    console.error('getAuditLogs error:', error);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
};
