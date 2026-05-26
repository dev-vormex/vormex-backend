// @ts-nocheck
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { collapseInboxNotifications, notificationService } from '../services/notification.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const notificationInclude = {
  users_notifications_actorIdTousers: {
    select: {
      id: true,
      username: true,
      name: true,
      profileImage: true,
      isVerified: true,
    },
  },
  posts: {
    select: {
      id: true,
      content: true,
      mediaUrls: true,
    },
  },
  reels: {
    select: {
      id: true,
      title: true,
      thumbnailUrl: true,
    },
  },
};

const formatNotification = (notification: any) => ({
  id: notification.id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  actor: notification.users_notifications_actorIdTousers,
  post: notification.posts,
  reel: notification.reels,
  data: notification.data,
  isRead: notification.isRead,
  readAt: notification.readAt?.toISOString() || null,
  createdAt: notification.createdAt.toISOString(),
});

// Get notifications with pagination
export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const cursor = ensureString(req.query.cursor);
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const unreadOnly = req.query.unreadOnly === 'true';

    const whereClause: any = { userId };
    
    if (unreadOnly) {
      whereClause.isRead = false;
    }
    
    if (cursor) {
      whereClause.createdAt = { lt: new Date(cursor) };
    }

    const rawTake = Math.min(limit * 3, 120) + 1;
    const notifications = await prisma.notifications.findMany({
      where: whereClause,
      include: notificationInclude,
      orderBy: { createdAt: 'desc' },
      take: rawTake,
    });

    const collapsedNotifications = collapseInboxNotifications(notifications);
    const hasMore = collapsedNotifications.length > limit;
    const results = hasMore ? collapsedNotifications.slice(0, limit) : collapsedNotifications;
    const formatted = results.map(formatNotification);

    res.json({
      notifications: formatted,
      nextCursor: hasMore && results.length > 0
        ? results[results.length - 1].createdAt.toISOString()
        : null,
      hasMore,
    });
  } catch (error) {
    console.error('Failed to fetch notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
};

// Get unread count
export const getUnreadCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const count = await notificationService.getUnreadCount(userId);
    res.json({ count });
  } catch (error) {
    console.error('Failed to fetch unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
};

// Mark notifications as read
export const markAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { notificationIds } = req.body;

    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
      res.status(400).json({ error: 'notificationIds must be a non-empty array' });
      return;
    }

    await notificationService.markAsRead(userId, notificationIds);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to mark notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
};

// Mark all notifications as read
export const markAllAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await notificationService.markAllAsRead(userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
};

// Delete a notification
export const deleteNotification = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const notificationId = ensureString(req.params.notificationId);
    if (!notificationId) {
      res.status(400).json({ error: 'Notification ID is required' });
      return;
    }

    await prisma.notifications.deleteMany({
      where: {
        id: notificationId,
        userId,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete notification:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
};

// Get notification settings (placeholder for future)
export const getSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Default settings - can be stored in user preferences later
    res.json({
      settings: {
        pushEnabled: true,
        messagesEnabled: true,
        connectionsEnabled: true,
        likesEnabled: true,
        commentsEnabled: true,
        mentionsEnabled: true,
        followsEnabled: true,
        matchAlertsEnabled: true,
        streakRemindersEnabled: true,
        dailyDigestEnabled: true,
        weeklySummaryEnabled: true,
      },
    });
  } catch (error) {
    console.error('Failed to fetch notification settings:', error);
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
};

// Update notification settings
export const updateSettings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // For now, just acknowledge the update
    // In a full implementation, this would be stored in the database
    const settings = req.body;
    
    console.log(`Notification settings updated for user ${userId}:`, settings);
    
    res.json({
      success: true,
      settings,
    });
  } catch (error) {
    console.error('Failed to update notification settings:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
};
