import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { notificationService } from "../../../notifications/services/notification.service";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { getCurrentReengagementWindow, isReengagementEnabled, getConfiguredReengagementSlots, runReengagementForUser, previewReengagementForUser } from "../../../notifications/services/reengagement-notification.service";
import { isRedisConfigured, isRedisEnabled } from "../../../../infrastructure/redis/client";
import { AuthRequest, normalizeOptionalString, parseStringArray, buildUserAudienceWhere, chunkArray, parseOptionalDateInput } from "./support.controller";

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
