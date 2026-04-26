// @ts-nocheck
/**
 * Notification Service
 * Handles in-app notifications with persistence and queue-driven delivery
 */

import { prisma } from '../config/prisma';
import { queueNames } from '../infrastructure/queue/queue-names';
import { enqueueOutboxEvent } from '../outbox/service';
import { cacheService } from './cache.service';
import { pushNotificationService } from './push-notification.service';

export type NotificationType = 
  | 'like'
  | 'comment'
  | 'comment_reply'
  | 'mention'
  | 'follow'
  | 'profile_view'
  | 'connection_request'
  | 'connection_accepted'
  | 'reel_like'
  | 'reel_comment'
  | 'reel_comment_reply'
  | 'reel_share'
  | 'reel_mention'
  | 'reel_view_milestone'
  | 'message'
  | 'streak_milestone'
  | 'streak_lost'
  | 'xp_earned'
  | 'post_share'
  | 'people_you_know_joined'
  | 'admin_announcement';

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  actorId?: string;
  postId?: string;
  reelId?: string;
  commentId?: string;
  messageId?: string;
  data?: Record<string, any>;
}

const notificationInclude = {
  users_notifications_actorIdTousers: {
    select: {
      id: true,
      username: true,
      name: true,
      profileImage: true,
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

const formatRealtimeNotification = (notification: any) => ({
  id: notification.id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  actor: notification.users_notifications_actorIdTousers,
  post: notification.posts,
  reel: notification.reels,
  data: notification.data,
  isRead: notification.isRead,
  createdAt: notification.createdAt.toISOString(),
});

const PROFILE_VIEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const PROFILE_VIEW_NAME_THRESHOLD = 10;
const PROFILE_VIEW_BATCH_LIMIT = 15;

const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asProfileViewers = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();

  return value.reduce<Array<{ id: string; name: string }>>((accumulator, item) => {
    const id = asString(item?.id);
    const name = asString(item?.name);

    if (!id || !name || seen.has(id)) {
      return accumulator;
    }

    seen.add(id);
    accumulator.push({ id, name });
    return accumulator;
  }, []);
};

const asDate = (value: unknown): Date | null => {
  const normalized = asString(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeProfileViewViewerName = (name?: string | null) => {
  const trimmed = asString(name);
  return trimmed || 'Someone';
};

const parseProfileViewNotificationData = (notification: any) => {
  const data = notification?.data && typeof notification.data === 'object'
    ? notification.data
    : {};
  const viewers = asProfileViewers(data.viewers);
  const fallbackActorId = asString(notification?.actorId);
  const fallbackActorName =
    normalizeProfileViewViewerName(
      notification?.users_notifications_actorIdTousers?.name ||
      notification?.users_notifications_actorIdTousers?.username
    );
  const normalizedViewers = viewers.length > 0
    ? viewers
    : fallbackActorId
      ? [{ id: fallbackActorId, name: fallbackActorName }]
      : [];

  const windowStartedAt =
    asDate(data.windowStartedAt) ||
    notification?.createdAt ||
    new Date();
  const batchKey =
    asString(data.batchKey) ||
    asString(data.notificationBatchKey) ||
    (notification?.id ? `profile_view:${notification.id}` : null) ||
    `profile_view:${windowStartedAt.getTime()}`;

  return {
    batchKey,
    windowStartedAt,
    viewers: normalizedViewers,
  };
};

const formatProfileViewNames = (names: string[]) => {
  if (names.length <= 0) {
    return 'Someone';
  }

  if (names.length === 1) {
    return names[0];
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names[0]}, ${names[1]}, and ${names.length - 2} others`;
};

const buildProfileViewNotificationCopy = (
  viewers: Array<{ id: string; name: string }>
) => {
  const viewerCount = viewers.length;
  const viewerNames = viewers.map((viewer) => viewer.name);

  if (viewerCount <= 1) {
    return {
      title: 'Profile view',
      body: `${viewerNames[0] || 'Someone'} viewed your profile`,
    };
  }

  if (viewerCount < PROFILE_VIEW_NAME_THRESHOLD) {
    return {
      title: 'Profile views',
      body: `${formatProfileViewNames(viewerNames)} viewed your profile in the last 3 days`,
    };
  }

  return {
    title: 'Profile views',
    body: `${viewerCount} people viewed your profile in the last 3 days`,
  };
};

const enqueueNotificationCreatedEvents = async (tx: any, notification: any) => {
  const payload = formatRealtimeNotification(notification);

  await enqueueOutboxEvent(tx as any, {
    aggregateType: 'notification',
    aggregateId: notification.id,
    eventType: 'notification.created',
    queueName: queueNames.realtimeFanout,
    payload: {
      envelopes: [
        {
          event: 'notification:new',
          users: [notification.userId],
          payload,
        },
        {
          event: `notification:${notification.type}`,
          users: [notification.userId],
          payload: {
            notificationId: notification.id,
            actor: payload.actor,
            post: payload.post,
            reel: payload.reel,
            data: notification.data,
          },
        },
      ],
    },
  });
};

const enqueueNotificationCacheInvalidation = async (
  tx: any,
  userId: string,
  notificationId: string,
  eventType: string = 'notification.cache.invalidate'
) => {
  await enqueueOutboxEvent(tx as any, {
    aggregateType: 'notification',
    aggregateId: notificationId,
    eventType,
    queueName: queueNames.cacheInvalidation,
    payload: {
      tags: [`notifications:${userId}`],
    },
  });
};

export const collapseInboxNotifications = (notifications: any[] = []) => {
  const seenConnectionRequests = new Set<string>();

  return notifications.filter((notification) => {
    if (notification?.type !== 'connection_request' || !notification?.actorId) {
      return true;
    }

    const key = `${notification.type}:${notification.actorId}`;
    if (seenConnectionRequests.has(key)) {
      return false;
    }

    seenConnectionRequests.add(key);
    return true;
  });
};

class NotificationService {
  /**
   * Create a notification and enqueue real-time fanout/cache invalidation.
   */
  async createNotification(params: CreateNotificationParams): Promise<void> {
    const { userId, type, title, body, actorId, postId, reelId, commentId, messageId, data } = params;

    // Don't notify yourself
    if (actorId && actorId === userId) {
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const notification = await tx.notifications.create({
          data: {
            userId,
            type,
            title,
            body,
            actorId,
            postId,
            reelId,
            commentId,
            messageId,
            data: data || {},
          },
          include: notificationInclude,
        });

        await enqueueNotificationCreatedEvents(tx, notification);
        await enqueueNotificationCacheInvalidation(tx, userId, notification.id);
      });
    } catch (error) {
      console.error('Failed to create notification:', error);
    }
  }

  async notifyProfileView(
    userId: string,
    viewerId: string,
    viewerName: string
  ): Promise<void> {
    if (!userId || !viewerId || userId === viewerId) {
      return;
    }

    const now = new Date();
    const normalizedViewerName = normalizeProfileViewViewerName(viewerName);

    try {
      const delivery = await prisma.$transaction(async (tx) => {
        const recentNotifications = await tx.notifications.findMany({
          where: {
            userId,
            type: 'profile_view',
          },
          include: notificationInclude,
          orderBy: { createdAt: 'desc' },
          take: 10,
        });

        const activeNotification = recentNotifications.find((notification) => {
          const parsed = parseProfileViewNotificationData(notification);
          return (
            now.getTime() - parsed.windowStartedAt.getTime() <= PROFILE_VIEW_WINDOW_MS &&
            parsed.viewers.length < PROFILE_VIEW_BATCH_LIMIT
          );
        });

        if (activeNotification) {
          const parsed = parseProfileViewNotificationData(activeNotification);

          if (parsed.viewers.some((viewer) => viewer.id === viewerId)) {
            return null;
          }

          const viewers = [
            { id: viewerId, name: normalizedViewerName },
            ...parsed.viewers,
          ].slice(0, PROFILE_VIEW_BATCH_LIMIT);
          const copy = buildProfileViewNotificationCopy(viewers);
          const data = {
            screen: 'profile',
            batchKey: parsed.batchKey,
            windowStartedAt: parsed.windowStartedAt.toISOString(),
            lastViewedAt: now.toISOString(),
            viewerCount: viewers.length,
            latestViewerId: viewerId,
            latestViewerName: normalizedViewerName,
            viewers,
          };

          await tx.notifications.update({
            where: { id: activeNotification.id },
            data: {
              title: copy.title,
              body: copy.body,
              actorId: viewerId,
              data,
              isRead: false,
              readAt: null,
              createdAt: now,
            },
          });

          await enqueueNotificationCacheInvalidation(
            tx,
            userId,
            activeNotification.id,
            'notification.profile_view.updated'
          );

          return {
            title: copy.title,
            body: copy.body,
            batchKey: parsed.batchKey,
            viewerCount: viewers.length,
            latestViewerId: viewerId,
          };
        }

        const batchKey = `profile_view:${userId}:${now.getTime()}`;
        const viewers = [{ id: viewerId, name: normalizedViewerName }];
        const copy = buildProfileViewNotificationCopy(viewers);
        const notification = await tx.notifications.create({
          data: {
            userId,
            type: 'profile_view',
            title: copy.title,
            body: copy.body,
            actorId: viewerId,
            createdAt: now,
            data: {
              screen: 'profile',
              batchKey,
              windowStartedAt: now.toISOString(),
              lastViewedAt: now.toISOString(),
              viewerCount: 1,
              latestViewerId: viewerId,
              latestViewerName: normalizedViewerName,
              viewers,
            },
          },
          include: notificationInclude,
        });

        await enqueueNotificationCreatedEvents(tx, notification);
        await enqueueNotificationCacheInvalidation(
          tx,
          userId,
          notification.id,
          'notification.profile_view.created'
        );

        return {
          title: copy.title,
          body: copy.body,
          batchKey,
          viewerCount: 1,
          latestViewerId: viewerId,
        };
      });

      if (!delivery) {
        return;
      }

      await pushNotificationService.pushProfileView(userId, {
        title: delivery.title,
        body: delivery.body,
        viewerId: delivery.latestViewerId,
        batchKey: delivery.batchKey,
        viewerCount: delivery.viewerCount,
      });
    } catch (error) {
      console.error('Failed to send profile view notification:', error);
    }
  }

  /**
   * Send notification for streak milestone
   */
  async notifyStreakMilestone(userId: string, streakType: string, count: number): Promise<void> {
    await this.createNotification({
      userId,
      type: 'streak_milestone',
      title: '🔥 Streak Milestone!',
      body: `Amazing! You've reached a ${count}-day ${streakType} streak!`,
      data: { streakType, count },
    });
  }

  /**
   * Send notification for streak lost
   */
  async notifyStreakLost(userId: string, streakType: string, previousCount: number): Promise<void> {
    await this.createNotification({
      userId,
      type: 'streak_lost',
      title: '😢 Streak Lost',
      body: `Your ${previousCount}-day ${streakType} streak has ended. Start fresh today!`,
      data: { streakType, previousCount },
    });
  }

  /**
   * Send XP earned notification
   */
  async notifyXpEarned(userId: string, amount: number, reason: string): Promise<void> {
    await this.createNotification({
      userId,
      type: 'xp_earned',
      title: '⭐ XP Earned!',
      body: `+${amount} XP for ${reason}`,
      data: { amount, reason },
    });
  }

  /**
   * Send connection request notification
   */
  async notifyConnectionRequest(userId: string, requesterId: string, requesterName: string): Promise<void> {
    await this.deleteConnectionRequestNotifications(userId, requesterId);

    await this.createNotification({
      userId,
      type: 'connection_request',
      title: '🤝 Connection Request',
      body: `${requesterName} wants to connect with you`,
      actorId: requesterId,
    });
  }

  async deleteConnectionRequestNotifications(userId: string, actorId: string): Promise<void> {
    await prisma.notifications.deleteMany({
      where: {
        userId,
        type: 'connection_request',
        actorId,
      },
    });
  }

  /**
   * Send connection accepted notification
   */
  async notifyConnectionAccepted(userId: string, accepterId: string, accepterName: string): Promise<void> {
    await this.createNotification({
      userId,
      type: 'connection_accepted',
      title: '✅ Connection Accepted',
      body: `${accepterName} accepted your connection request`,
      actorId: accepterId,
    });
  }

  async notifyPeopleYouKnowJoined(
    userId: string,
    count: number,
    actorId?: string
  ): Promise<void> {
    const body =
      count > 1 ? `${count} contacts just joined Vormex` : 'A contact just joined Vormex';

    await this.createNotification({
      userId,
      type: 'people_you_know_joined',
      title: 'People You Know',
      body,
      actorId,
      data: {
        count,
        screen: 'find_people',
        tab: 'people_you_know',
      },
    });
  }

  async notifyAdminAnnouncement(
    userId: string,
    title: string,
    body: string,
    data: Record<string, any> = {}
  ): Promise<void> {
    await this.createNotification({
      userId,
      type: 'admin_announcement',
      title,
      body,
      data: {
        senderType: 'admin',
        branding: 'vormex',
        source: 'admin_panel',
        ...data,
      },
    });
  }

  /**
   * Send notification when someone comments on a post
   */
  async notifyPostComment(
    postAuthorId: string,
    commenterId: string,
    commenterName: string,
    postId: string,
    commentId: string,
    commentPreview: string
  ): Promise<void> {
    await this.createNotification({
      userId: postAuthorId,
      type: 'comment',
      title: '💬 New Comment',
      body: `${commenterName} commented: "${commentPreview.slice(0, 50)}${commentPreview.length > 50 ? '...' : ''}"`,
      actorId: commenterId,
      postId,
      commentId,
      data: { commentPreview },
    });
  }

  /**
   * Send notification when someone replies to a comment
   */
  async notifyCommentReply(
    originalCommenterId: string,
    replierId: string,
    replierName: string,
    postId: string,
    commentId: string,
    replyPreview: string
  ): Promise<void> {
    await this.createNotification({
      userId: originalCommenterId,
      type: 'comment_reply',
      title: '↩️ New Reply',
      body: `${replierName} replied: "${replyPreview.slice(0, 50)}${replyPreview.length > 50 ? '...' : ''}"`,
      actorId: replierId,
      postId,
      commentId,
      data: { replyPreview },
    });
  }

  /**
   * Send notification when someone likes a post
   */
  async notifyPostLike(
    postAuthorId: string,
    likerId: string,
    likerName: string,
    postId: string
  ): Promise<void> {
    await this.createNotification({
      userId: postAuthorId,
      type: 'like',
      title: '❤️ New Like',
      body: `${likerName} liked your post`,
      actorId: likerId,
      postId,
    });
  }

  /**
   * Send notification when someone shares a post
   */
  async notifyPostShare(
    postAuthorId: string,
    sharerId: string,
    sharerName: string,
    postId: string
  ): Promise<void> {
    await this.createNotification({
      userId: postAuthorId,
      type: 'post_share',
      title: '🔗 Post Shared',
      body: `${sharerName} shared your post`,
      actorId: sharerId,
      postId,
    });
  }

  /**
   * Send notification when someone mentions a user
   */
  async notifyMention(
    mentionedUserId: string,
    mentionerId: string,
    mentionerName: string,
    context: 'post' | 'comment' | 'reel' | 'reel_comment',
    referenceId: string,
    preview: string
  ): Promise<void> {
    const typeMap = {
      post: 'mention' as NotificationType,
      comment: 'mention' as NotificationType,
      reel: 'reel_mention' as NotificationType,
      reel_comment: 'reel_mention' as NotificationType,
    };

    await this.createNotification({
      userId: mentionedUserId,
      type: typeMap[context],
      title: '📢 You were mentioned',
      body: `${mentionerName} mentioned you: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`,
      actorId: mentionerId,
      postId: context === 'post' || context === 'comment' ? referenceId : undefined,
      reelId: context === 'reel' || context === 'reel_comment' ? referenceId : undefined,
      data: { context, preview },
    });
  }

  /**
   * Send notification when someone follows a user
   */
  async notifyFollow(
    userId: string,
    followerId: string,
    followerName: string
  ): Promise<void> {
    await this.createNotification({
      userId,
      type: 'follow',
      title: 'New Follower',
      body: `${followerName} started following you`,
      actorId: followerId,
    });
  }

  // ============================================
  // REEL-SPECIFIC NOTIFICATIONS
  // ============================================

  /**
   * Send notification when someone likes a reel
   */
  async notifyReelLike(
    reelAuthorId: string,
    likerId: string,
    likerName: string,
    reelId: string
  ): Promise<void> {
    await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_like',
      title: '❤️ New Like on Reel',
      body: `${likerName} liked your reel`,
      actorId: likerId,
      reelId,
    });
  }

  /**
   * Send notification when someone comments on a reel
   */
  async notifyReelComment(
    reelAuthorId: string,
    commenterId: string,
    commenterName: string,
    reelId: string,
    commentId: string,
    commentPreview: string
  ): Promise<void> {
    await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_comment',
      title: '💬 New Comment on Reel',
      body: `${commenterName} commented: "${commentPreview.slice(0, 50)}${commentPreview.length > 50 ? '...' : ''}"`,
      actorId: commenterId,
      reelId,
      commentId,
      data: { commentPreview },
    });
  }

  /**
   * Send notification when someone replies to a reel comment
   */
  async notifyReelCommentReply(
    originalCommenterId: string,
    replierId: string,
    replierName: string,
    reelId: string,
    commentId: string,
    replyPreview: string
  ): Promise<void> {
    await this.createNotification({
      userId: originalCommenterId,
      type: 'reel_comment_reply',
      title: '↩️ New Reply on Reel',
      body: `${replierName} replied: "${replyPreview.slice(0, 50)}${replyPreview.length > 50 ? '...' : ''}"`,
      actorId: replierId,
      reelId,
      commentId,
      data: { replyPreview },
    });
  }

  /**
   * Send notification when someone shares a reel
   */
  async notifyReelShare(
    reelAuthorId: string,
    sharerId: string,
    sharerName: string,
    reelId: string
  ): Promise<void> {
    await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_share',
      title: '🔗 Reel Shared',
      body: `${sharerName} shared your reel`,
      actorId: sharerId,
      reelId,
    });
  }

  /**
   * Send notification for reel view milestones
   */
  async notifyReelViewMilestone(
    reelAuthorId: string,
    reelId: string,
    viewCount: number
  ): Promise<void> {
    const milestoneText = viewCount >= 1000000 
      ? `${(viewCount / 1000000).toFixed(1)}M` 
      : viewCount >= 1000 
      ? `${(viewCount / 1000).toFixed(1)}K` 
      : viewCount.toString();

    await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_view_milestone',
      title: '🎉 Milestone Reached!',
      body: `Your reel reached ${milestoneText} views!`,
      reelId,
      data: { viewCount },
    });
  }

  // ============================================
  // BATCH OPERATIONS
  // ============================================

  /**
   * Mark notifications as read
   */
  async markAsRead(userId: string, notificationIds: string[]): Promise<void> {
    const targetNotifications = await prisma.notifications.findMany({
      where: {
        id: { in: notificationIds },
        userId,
      },
      select: {
        id: true,
        type: true,
        actorId: true,
      },
    });

    const connectionRequestActorIds = Array.from(
      new Set(
        targetNotifications
          .filter((notification) => notification.type === 'connection_request' && notification.actorId)
          .map((notification) => notification.actorId),
      ),
    );

    const orClauses: any[] = [{ id: { in: notificationIds } }];
    if (connectionRequestActorIds.length > 0) {
      orClauses.push({
        type: 'connection_request',
        actorId: { in: connectionRequestActorIds },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.notifications.updateMany({
        where: {
          userId,
          OR: orClauses,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'notification',
        aggregateId: userId,
        eventType: 'notification.read',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`notifications:${userId}`],
        },
      });
    });
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.notifications.updateMany({
        where: {
          userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'notification',
        aggregateId: userId,
        eventType: 'notification.read_all',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`notifications:${userId}`],
        },
      });
    });
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    const cacheKey = `notifications:unread:${userId}`;
    const cached = await cacheService.get<number>(cacheKey);
    if (typeof cached === 'number') {
      return cached;
    }

    const unreadNotifications = await prisma.notifications.findMany({
      where: {
        userId,
        isRead: false,
      },
      select: {
        id: true,
        type: true,
        actorId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const count = collapseInboxNotifications(unreadNotifications).length;
    await cacheService.set(cacheKey, count, 15, [`notifications:${userId}`]);
    return count;
  }

  /**
   * Delete old notifications (cleanup job)
   */
  async deleteOldNotifications(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await prisma.notifications.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        isRead: true,
      },
    });

    return result.count;
  }
}

export const notificationService = new NotificationService();
