// @ts-nocheck
import { Request, Response } from 'express';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { prisma } from '../config/prisma';
import { bunnyConfig } from '../config/bunny.config';
import { notificationService } from '../services/notification.service';
import { pushNotificationService } from '../services/push-notification.service';
import { bunnyStorageService } from '../services/bunny-storage.service';
import {
  getConfiguredReengagementSlots,
  getCurrentReengagementWindow,
  isReengagementEnabled,
  previewReengagementForUser,
  runReengagementForUser,
} from '../services/reengagement-notification.service';
import { isRedisConfigured, isRedisEnabled } from '../infrastructure/redis/client';
import { getIO } from '../sockets';
import { decryptToken, encryptToken } from '../utils/encryption.util';
import {
  isAuthSessionTwoFactorVerified,
  markAuthSessionTwoFactorVerified,
  revokeAllAuthSessions,
} from '../services/auth-session.service';
import { invalidateAuthUserStatus } from '../services/auth-user-status-cache.service';

interface AuthRequest extends Request {
  user?: { userId: string; sessionId?: string };
}

function encryptAdminTwoFactorSecret(secret: string): string {
  return `enc:${encryptToken(secret)}`;
}

function decryptAdminTwoFactorSecret(secret: string | null | undefined): string | null {
  if (!secret) {
    return null;
  }

  if (secret.startsWith('enc:')) {
    return decryptToken(secret.slice(4));
  }

  return secret;
}

function verifyTotpToken(secret: string, token: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1,
  });
}

async function getAdminTwoFactorUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      isAdmin: true,
      adminTwoFactorEnabled: true,
      adminTwoFactorSecret: true,
    },
  });
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

const parseOptionalDateInput = (value: any): Date | undefined => {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
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
  hasActivePushToken: (user.device_tokens?.length ?? 0) > 0,
  activePushPlatforms: Array.from(new Set((user.device_tokens ?? []).map((entry: any) => entry.platform))),
  lastPushTokenAt: user.device_tokens?.[0]?.updatedAt ?? null,
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

const CHAT_CLEAR_CONFIRMATION = 'CLEAR ALL CHATS';
const GROUP_CHAT_CLEAR_CONFIRMATION = 'CLEAR GROUP CHAT';
const BUNNY_CDN_BASE_URL = bunnyConfig.cdn.pullZoneUrl.replace(/\/+$/, '');

const getBunnyStoragePath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) && !trimmed.startsWith(BUNNY_CDN_BASE_URL)) {
    return null;
  }
  const storagePath = trimmed.startsWith(BUNNY_CDN_BASE_URL)
    ? trimmed.slice(BUNNY_CDN_BASE_URL.length).replace(/^\/+/, '')
    : trimmed.replace(/^\/+/, '');
  return storagePath || null;
};

const isBunnyStorageAsset = (value: unknown, allowedPrefixes: string[]): value is string => {
  const storagePath = getBunnyStoragePath(value);
  if (!storagePath) return false;
  return allowedPrefixes.some((prefix) => storagePath.startsWith(prefix));
};

const isChatUploadUrl = (value: unknown): value is string => {
  return isBunnyStorageAsset(value, ['chat/']);
};

const isGroupUploadUrl = (value: unknown): value is string => {
  return isBunnyStorageAsset(value, ['groups/icons/', 'groups/covers/']);
};

const collectChatMediaAssets = async () => {
  const [directMediaRows, groupMediaRows] = await Promise.all([
    prisma.messages.findMany({
      where: { mediaUrl: { not: null } },
      select: { mediaUrl: true, fileSize: true },
    }),
    prisma.group_messages.findMany({
      where: { mediaUrl: { not: null } },
      select: { mediaUrl: true, fileSize: true },
    }),
  ]);

  const assetsByUrl = new Map<string, number>();

  [...directMediaRows, ...groupMediaRows].forEach((row) => {
    if (!isChatUploadUrl(row.mediaUrl)) return;
    const url = row.mediaUrl.trim();
    const size = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize)
      ? Math.max(row.fileSize, 0)
      : 0;
    assetsByUrl.set(url, Math.max(assetsByUrl.get(url) || 0, size));
  });

  return {
    urls: Array.from(assetsByUrl.keys()),
    bytes: Array.from(assetsByUrl.values()).reduce((total, size) => total + size, 0),
    directMediaRows: directMediaRows.length,
    groupMediaRows: groupMediaRows.length,
  };
};

const collectGroupChatMediaAssets = async (groupId: string) => {
  const mediaRows = await prisma.group_messages.findMany({
    where: { groupId, mediaUrl: { not: null } },
    select: { mediaUrl: true, fileSize: true },
  });

  const assetsByUrl = new Map<string, number>();

  mediaRows.forEach((row) => {
    if (!isChatUploadUrl(row.mediaUrl)) return;
    const url = row.mediaUrl.trim();
    const size = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize)
      ? Math.max(row.fileSize, 0)
      : 0;
    assetsByUrl.set(url, Math.max(assetsByUrl.get(url) || 0, size));
  });

  return {
    urls: Array.from(assetsByUrl.keys()),
    bytes: Array.from(assetsByUrl.values()).reduce((total, size) => total + size, 0),
    mediaRows: mediaRows.length,
  };
};

const deleteBunnyAssets = async (urls: string[]) => {
  const result = {
    deleted: 0,
    failed: 0,
    failedUrls: [] as string[],
  };

  for (const batch of chunkArray(urls, 10)) {
    const settled = await Promise.allSettled(
      batch.map((url) => bunnyStorageService.deleteFile(url))
    );

    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') {
        result.deleted += 1;
      } else {
        result.failed += 1;
        if (result.failedUrls.length < 10) {
          result.failedUrls.push(batch[index]);
        }
      }
    });
  }

  return result;
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

    const twoFactorVerified = user.adminTwoFactorEnabled
      ? await isAuthSessionTwoFactorVerified(req.user.sessionId, String(req.user.userId))
      : true;

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
      requiresTwoFactor: user.adminTwoFactorEnabled && !twoFactorVerified,
    });
  } catch (error) {
    console.error('verifyAdmin error:', error);
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
};

// ============================================
// 2FA
// ============================================

export const setup2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await getAdminTwoFactorUser(userId);
    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const secret = speakeasy.generateSecret({
      issuer: 'Vormex',
      name: `Vormex Admin (${user.email})`,
      length: 32,
    });

    if (!secret.base32 || !secret.otpauth_url) {
      res.status(500).json({ error: 'Failed to generate 2FA secret' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        adminTwoFactorEnabled: false,
        adminTwoFactorSecret: encryptAdminTwoFactorSecret(secret.base32),
      },
    });

    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      secret: secret.base32,
      qrCode,
      message: 'Scan the QR code and verify a 6-digit code to enable 2FA.',
    });
  } catch (error) {
    console.error('setup2FA error:', error);
    res.status(500).json({ error: 'Failed to setup 2FA' });
  }
};

export const verify2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const token = String(req.body?.token || '').trim();

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!/^\d{6}$/.test(token)) {
      res.status(400).json({ error: 'A valid 6-digit code is required' });
      return;
    }

    const user = await getAdminTwoFactorUser(userId);
    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const secret = decryptAdminTwoFactorSecret(user.adminTwoFactorSecret);
    if (!secret || !verifyTotpToken(secret, token)) {
      res.status(401).json({ error: 'Invalid two-factor code' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        adminTwoFactorEnabled: true,
      },
    });
    await markAuthSessionTwoFactorVerified(req.user?.sessionId, userId);

    res.json({ success: true, message: '2FA verified' });
  } catch (error) {
    console.error('verify2FA error:', error);
    res.status(500).json({ error: 'Failed to verify 2FA' });
  }
};

export const validate2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const token = String(req.body?.token || '').trim();

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!/^\d{6}$/.test(token)) {
      res.status(400).json({ error: 'A valid 6-digit code is required' });
      return;
    }

    const user = await getAdminTwoFactorUser(userId);
    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    if (!user.adminTwoFactorEnabled) {
      res.json({ success: true, verified: true });
      return;
    }

    const secret = decryptAdminTwoFactorSecret(user.adminTwoFactorSecret);
    if (!secret || !verifyTotpToken(secret, token)) {
      res.status(401).json({ error: 'Invalid two-factor code' });
      return;
    }

    await markAuthSessionTwoFactorVerified(req.user?.sessionId, userId);

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

export const getReengagementNotificationStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const now = parseOptionalDateInput(req.query?.now) || new Date();
    const window = getCurrentReengagementWindow(now);

    const [recentDeliveries, deliveryBreakdown] = await Promise.all([
      prisma.reengagement_notification_deliveries.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: {
          userId: true,
          campaignDateKey: true,
          slotKey: true,
          campaignType: true,
          status: true,
          title: true,
          reason: true,
          sentAt: true,
          createdAt: true,
        },
      }),
      window.slotDateKey
        ? prisma.reengagement_notification_deliveries.groupBy({
            by: ['slotKey', 'status'],
            where: {
              campaignDateKey: window.slotDateKey,
            },
            _count: {
              _all: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const fcmConfigured = Boolean(
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    );

    res.json({
      enabled: isReengagementEnabled(),
      redisConfigured: isRedisConfigured(),
      redisConnected: isRedisEnabled(),
      fcmConfigured,
      now: now.toISOString(),
      currentIstHour: window.currentIstHour,
      currentSlotKey: window.slot?.key || null,
      currentSlotDateKey: window.slotDateKey,
      configuredSlots: getConfiguredReengagementSlots().map((slot) => ({
        hourIst: slot.hourIst,
        key: slot.key,
        tone: slot.tone,
      })),
      deliveryBreakdown,
      recentDeliveries,
      note: 'Scheduler and worker must be running as separate services for automatic delivery.',
    });
  } catch (error) {
    console.error('getReengagementNotificationStatus error:', error);
    res.status(500).json({ error: 'Failed to load re-engagement notification status' });
  }
};

export const runReengagementNotificationDryRun = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = normalizeOptionalString(req.body?.userId);
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    if (req.body?.now && !parseOptionalDateInput(req.body.now)) {
      res.status(400).json({ error: 'Invalid now value. Use an ISO date string.' });
      return;
    }

    const now = parseOptionalDateInput(req.body?.now) || new Date();
    const send = req.body?.send === true || req.body?.send === 'true';
    const result = send
      ? await runReengagementForUser(userId, now)
      : await previewReengagementForUser(userId, now);

    res.json({
      ...result,
      mode: send ? 'send' : 'preview',
      requestedAt: now.toISOString(),
    });
  } catch (error) {
    console.error('runReengagementNotificationDryRun error:', error);
    res.status(500).json({ error: 'Failed to run re-engagement dry run' });
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
    if (Object.prototype.hasOwnProperty.call(data, 'isVerified')) {
      await invalidateAuthUserStatus(id);
    }

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
    await invalidateAuthUserStatus(id);
    await revokeAllAuthSessions(id);

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

    const { id } = req.params;
    await prisma.user.update({
      where: { id },
      data: { isBanned: false },
    });
    await invalidateAuthUserStatus(id);

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

    const { id } = req.params;
    await prisma.user.update({
      where: { id },
      data: { isVerified: true },
    });
    await invalidateAuthUserStatus(id);

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

    await revokeAllAuthSessions(id);
    await prisma.user.delete({ where: { id } });
    await invalidateAuthUserStatus(id);

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

const mapAdminGroup = (group: any) => ({
  id: group.id,
  name: group.name,
  slug: group.slug,
  description: group.description,
  privacy: group.isPrivate ? 'private' : 'public',
  coverImage: group.coverImage || group.imageUrl || null,
  iconImage: group.iconImage || group.imageUrl || null,
  imageUrl: group.imageUrl || null,
  memberCount: group.memberCount,
  createdAt: group.createdAt,
  updatedAt: group.updatedAt,
  createdBy: group.users,
  _count: {
    members: group._count?.group_members ?? 0,
    posts: group._count?.group_messages ?? 0,
    messages: group._count?.group_messages ?? 0,
  },
});

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
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
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
          iconImage: true,
          imageUrl: true,
          memberCount: true,
          createdAt: true,
          updatedAt: true,
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

    const mappedGroups = groups.map(mapAdminGroup);

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

    const groupId = req.params.id;
    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        imageUrl: true,
        iconImage: true,
        coverImage: true,
        _count: {
          select: {
            group_members: true,
            group_messages: true,
          },
        },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const chatMediaAssets = await collectGroupChatMediaAssets(groupId);
    const groupImageUrls = [group.imageUrl, group.iconImage, group.coverImage]
      .filter(isGroupUploadUrl)
      .map((url) => url.trim());
    const assetUrls = Array.from(new Set([...chatMediaAssets.urls, ...groupImageUrls]));
    const mediaDeletion = await deleteBunnyAssets(assetUrls);

    if (mediaDeletion.failed > 0) {
      res.status(502).json({
        error: 'Some group media files could not be deleted. Database rows were left in place so the delete can be retried.',
        media: {
          filesFound: assetUrls.length,
          deleted: mediaDeletion.deleted,
          failed: mediaDeletion.failed,
          failedUrls: mediaDeletion.failedUrls,
        },
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.group_messages.updateMany({
        where: { groupId },
        data: { replyToId: null },
      });
      await tx.group_members.deleteMany({ where: { groupId } });
      await tx.groups.delete({ where: { id: groupId } });
    }, {
      maxWait: 15_000,
      timeout: 60_000,
    });

    getIO()?.to(`group:${groupId}`).emit('group:deleted', {
      groupId,
      deletedBy: String(req.user.userId),
      deletedAt: new Date().toISOString(),
    });

    res.json({
      message: 'Group deleted successfully',
      deleted: {
        groupId,
        members: group._count.group_members,
        messages: group._count.group_messages,
      },
      media: {
        filesFound: assetUrls.length,
        deleted: mediaDeletion.deleted,
        failed: mediaDeletion.failed,
      },
    });
  } catch (error) {
    console.error('deleteGroup error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
};

export const getAdminGroupMembers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = normalizeOptionalString(req.query.search);
    const role = normalizeOptionalString(req.query.role);
    const skip = (page - 1) * limit;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isPrivate: true,
        imageUrl: true,
        iconImage: true,
        coverImage: true,
        memberCount: true,
        createdAt: true,
        updatedAt: true,
        users: {
          select: { id: true, name: true, username: true },
        },
        _count: {
          select: {
            group_members: true,
            group_messages: true,
          },
        },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const memberWhere: any = { groupId };
    if (role && role !== 'all') {
      memberWhere.role = role.toLowerCase();
    }

    if (search) {
      const matchedUsers = await prisma.user.findMany({
        where: {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 200,
      });
      memberWhere.userId = { in: matchedUsers.map((user) => user.id) };
    }

    const [members, total] = await Promise.all([
      prisma.group_members.findMany({
        where: memberWhere,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
      }),
      prisma.group_members.count({ where: memberWhere }),
    ]);

    const users = await prisma.user.findMany({
      where: { id: { in: members.map((member) => member.userId) } },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        profileImage: true,
        headline: true,
        isBanned: true,
      },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));

    res.json({
      group: mapAdminGroup(group),
      members: members.map((member) => ({
        id: member.id,
        groupId: member.groupId,
        userId: member.userId,
        role: member.role,
        joinedAt: member.joinedAt,
        isCreator: group.users?.id === member.userId,
        user: usersById.get(member.userId) || {
          id: member.userId,
          name: 'Unknown user',
          username: null,
          email: null,
          profileImage: null,
          headline: null,
          isBanned: false,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getAdminGroupMembers error:', error);
    res.status(500).json({ error: 'Failed to load group members' });
  }
};

export const updateAdminGroupMemberRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const userId = req.params.userId;
    const role = normalizeOptionalString(req.body?.role)?.toLowerCase();
    const allowedRoles = ['member', 'moderator', 'admin', 'owner'];

    if (!role || !allowedRoles.includes(role)) {
      res.status(400).json({ error: 'Choose a valid group role' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { creatorId: true },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (group.creatorId === userId && role !== 'owner') {
      res.status(400).json({ error: 'The group creator must remain owner' });
      return;
    }

    const member = await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: { role },
    });

    res.json({
      message: 'Member role updated successfully',
      member,
    });
  } catch (error) {
    console.error('updateAdminGroupMemberRole error:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

export const removeAdminGroupMember = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const userId = req.params.userId;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, creatorId: true },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (group.creatorId === userId) {
      res.status(400).json({ error: 'Cannot remove the group creator. Delete the group instead.' });
      return;
    }

    const existingMember = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    if (!existingMember) {
      res.status(404).json({ error: 'Member not found in this group' });
      return;
    }

    const nextMemberCount = await prisma.$transaction(async (tx) => {
      await tx.group_members.delete({
        where: { groupId_userId: { groupId, userId } },
      });
      const memberCount = await tx.group_members.count({ where: { groupId } });
      await tx.groups.update({
        where: { id: groupId },
        data: { memberCount, updatedAt: new Date() },
      });
      return memberCount;
    });

    getIO()?.to(`group:${groupId}`).emit('group:member_removed', {
      groupId,
      userId,
      removedBy: String(req.user.userId),
      memberCount: nextMemberCount,
    });

    res.json({
      message: 'Member removed successfully',
      memberCount: nextMemberCount,
    });
  } catch (error) {
    console.error('removeAdminGroupMember error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

export const clearAdminGroupChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const confirmText = typeof req.body?.confirmText === 'string'
      ? req.body.confirmText.trim()
      : '';

    if (confirmText !== GROUP_CHAT_CLEAR_CONFIRMATION) {
      res.status(400).json({
        error: `Type "${GROUP_CHAT_CLEAR_CONFIRMATION}" to clear this group chat.`,
        confirmationText: GROUP_CHAT_CLEAR_CONFIRMATION,
      });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, name: true },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const chatMediaAssets = await collectGroupChatMediaAssets(groupId);
    const mediaDeletion = await deleteBunnyAssets(chatMediaAssets.urls);

    if (mediaDeletion.failed > 0) {
      res.status(502).json({
        error: 'Some group chat media files could not be deleted. Database rows were left in place so the clear can be retried.',
        media: {
          filesFound: chatMediaAssets.urls.length,
          bytesFromRows: chatMediaAssets.bytes,
          deleted: mediaDeletion.deleted,
          failed: mediaDeletion.failed,
          failedUrls: mediaDeletion.failedUrls,
        },
      });
      return;
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const groupMessages = await tx.group_messages.count({ where: { groupId } });
      const groupReactions = await tx.group_message_reactions.count({
        where: { group_messages: { groupId } },
      });

      await tx.group_messages.updateMany({
        where: { groupId },
        data: { replyToId: null },
      });
      await tx.group_messages.deleteMany({ where: { groupId } });
      await tx.groups.update({
        where: { id: groupId },
        data: { updatedAt: new Date() },
      });

      return {
        groupMessages,
        groupReactions,
      };
    }, {
      maxWait: 15_000,
      timeout: 60_000,
    });

    getIO()?.to(`group:${groupId}`).emit('group:chat_cleared', {
      groupId,
      clearedBy: String(req.user.userId),
      clearedAt: new Date().toISOString(),
    });

    res.json({
      message: 'Group chat cleared successfully',
      group: {
        id: group.id,
        name: group.name,
      },
      deleted,
      media: {
        filesFound: chatMediaAssets.urls.length,
        bytesFromRows: chatMediaAssets.bytes,
        deleted: mediaDeletion.deleted,
        failed: mediaDeletion.failed,
      },
    });
  } catch (error) {
    console.error('clearAdminGroupChat error:', error);
    res.status(500).json({ error: 'Failed to clear group chat' });
  }
};

// ============================================
// CHAT STORAGE
// ============================================

export const getChatStorageSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [
      conversations,
      directMessages,
      groupMessages,
      directReactions,
      groupReactions,
      messageNotifications,
      moderationChatReports,
      chatMediaAssets,
    ] = await Promise.all([
      prisma.conversations.count(),
      prisma.messages.count(),
      prisma.group_messages.count(),
      prisma.message_reactions.count(),
      prisma.group_message_reactions.count(),
      prisma.notifications.count({
        where: {
          OR: [
            { messageId: { not: null } },
            { type: { in: ['message', 'new_message', 'group_message'] } },
          ],
        },
      }),
      prisma.moderation_reports.count({
        where: { conversationId: { not: null } },
      }),
      collectChatMediaAssets(),
    ]);

    res.json({
      confirmationText: CHAT_CLEAR_CONFIRMATION,
      summary: {
        conversations,
        directMessages,
        groupMessages,
        directReactions,
        groupReactions,
        messageNotifications,
        moderationChatReports,
        mediaMessages: chatMediaAssets.directMediaRows + chatMediaAssets.groupMediaRows,
        chatUploadFiles: chatMediaAssets.urls.length,
        chatUploadBytes: chatMediaAssets.bytes,
      },
    });
  } catch (error) {
    console.error('getChatStorageSummary error:', error);
    res.status(500).json({ error: 'Failed to load chat storage summary' });
  }
};

export const clearAllChats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const confirmText = typeof req.body?.confirmText === 'string'
      ? req.body.confirmText.trim()
      : '';

    if (confirmText !== CHAT_CLEAR_CONFIRMATION) {
      res.status(400).json({
        error: `Type "${CHAT_CLEAR_CONFIRMATION}" to clear every chat.`,
        confirmationText: CHAT_CLEAR_CONFIRMATION,
      });
      return;
    }

    const chatMediaAssets = await collectChatMediaAssets();
    const mediaDeletion = await deleteBunnyAssets(chatMediaAssets.urls);

    if (mediaDeletion.failed > 0) {
      res.status(502).json({
        error: 'Some chat media files could not be deleted. Database rows were left in place so the clear can be retried.',
        media: {
          filesFound: chatMediaAssets.urls.length,
          bytesFromRows: chatMediaAssets.bytes,
          deleted: mediaDeletion.deleted,
          failed: mediaDeletion.failed,
          failedUrls: mediaDeletion.failedUrls,
        },
      });
      return;
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const messageNotifications = await tx.notifications.deleteMany({
        where: {
          OR: [
            { messageId: { not: null } },
            { type: { in: ['message', 'new_message', 'group_message'] } },
          ],
        },
      });

      const moderationReportsDetached = await tx.moderation_reports.updateMany({
        where: { conversationId: { not: null } },
        data: { conversationId: null },
      });

      const outboxEvents = await tx.outboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateType: { in: ['message', 'conversation', 'group_message'] } },
            { eventType: { startsWith: 'chat.' } },
            { eventType: { startsWith: 'group.message.' } },
          ],
        },
      });

      await tx.messages.updateMany({ data: { replyToId: null } });
      await tx.group_messages.updateMany({ data: { replyToId: null } });

      const directReactions = await tx.message_reactions.deleteMany({});
      const groupReactions = await tx.group_message_reactions.deleteMany({});
      const directMessages = await tx.messages.deleteMany({});
      const conversations = await tx.conversations.deleteMany({});
      const groupMessages = await tx.group_messages.deleteMany({});

      return {
        conversations: conversations.count,
        directMessages: directMessages.count,
        groupMessages: groupMessages.count,
        directReactions: directReactions.count,
        groupReactions: groupReactions.count,
        messageNotifications: messageNotifications.count,
        moderationReportsDetached: moderationReportsDetached.count,
        outboxEvents: outboxEvents.count,
      };
    }, {
      maxWait: 15_000,
      timeout: 120_000,
    });

    getIO()?.emit('chat:cleared', {
      clearedBy: String(req.user.userId),
      clearedAt: new Date().toISOString(),
    });
    getIO()?.emit('group:chat_cleared', {
      clearedBy: String(req.user.userId),
      clearedAt: new Date().toISOString(),
    });

    res.json({
      message: 'All chats cleared successfully',
      deleted,
      media: {
        filesFound: chatMediaAssets.urls.length,
        bytesFromRows: chatMediaAssets.bytes,
        deleted: mediaDeletion.deleted,
        failed: mediaDeletion.failed,
      },
    });
  } catch (error) {
    console.error('clearAllChats error:', error);
    res.status(500).json({ error: 'Failed to clear chats' });
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

    let bannedUserId: string | null = null;
    await prisma.$transaction(async (tx) => {
      if (action === 'USER_BANNED' && report.reportedUserId && report.reportedUserId !== adminId) {
        await tx.user.update({
          where: { id: report.reportedUserId },
          data: { isBanned: true },
        });
        bannedUserId = report.reportedUserId;
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
    await invalidateAuthUserStatus(bannedUserId);

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
