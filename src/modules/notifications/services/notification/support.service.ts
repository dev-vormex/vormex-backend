import { enqueueOutboxEvent } from "../../../../infrastructure/outbox/service";
import { queueNames } from "../../../../infrastructure/queue/queue-names";

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
  | 'recommended_match'
  | 'saved_search_digest'
  | 'people_you_know_joined'
  | 'hackathon_team_match'
  | 'hackathon_new_match'
  | 'hackathon_team_application'
  | 'hackathon_team_application_accepted'
  | 'hackathon_weekly_digest'
  | 'skill_endorsement'
  | 'skill_swap_request'
  | 'skill_swap_accepted'
  | 'skill_swap_completed'
  | 'college_community_joined'
  | 'identity_verification_approved'
  | 'identity_verification_resubmit_requested'
  | 'admin_announcement';

export interface CreateNotificationParams {
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

export const notificationInclude = {
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

export const formatRealtimeNotification = (notification: any) => ({
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

export const PROFILE_VIEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export const PROFILE_VIEW_BATCH_LIMIT = 15;

export const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return null;
};

export const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const asDate = (value: unknown): Date | null => {
  const normalized = asString(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const enqueueNotificationCreatedEvents = async (tx: any, notification: any) => {
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

export const enqueueNotificationCacheInvalidation = async (
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
