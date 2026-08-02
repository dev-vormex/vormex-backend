// @ts-nocheck
/**
 * Notification Service
 * Handles in-app notifications with persistence and queue-driven delivery
 */

import { prisma } from '../config/prisma';
import { areUsersBlocked } from './trust-safety.service';
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
const PROFILE_VIEW_BATCH_LIMIT = 15;

const asBoolean = (value: unknown): boolean | null => {
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

  return value.reduce<Array<{ id: string; name: string; sameCollege: boolean }>>((accumulator, item) => {
    const id = asString(item?.id);
    const name = asString(item?.name);
    const sameCollege = asBoolean(item?.sameCollege) ?? false;

    if (!id || !name || seen.has(id)) {
      return accumulator;
    }

    seen.add(id);
    accumulator.push({ id, name, sameCollege });
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
  const fallbackSameCollege = asBoolean(data.sameCollegeHint) ?? false;
  const normalizedViewers = viewers.length > 0
    ? viewers
    : fallbackActorId
      ? [{ id: fallbackActorId, name: fallbackActorName, sameCollege: fallbackSameCollege }]
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

const buildProfileViewNotificationCopy = (
  viewers: Array<{ id: string; name: string; sameCollege: boolean }>
) => {
  const viewerCount = viewers.length;
  const sameCollegeCount = viewers.filter((viewer) => viewer.sameCollege).length;

  if (viewerCount <= 1) {
    if (sameCollegeCount > 0) {
      return {
        title: 'Campus profile view',
        body: 'Someone from your college viewed your profile',
      };
    }

    return {
      title: 'Profile view',
      body: 'Someone viewed your profile',
    };
  }

  if (sameCollegeCount === viewerCount) {
    return {
      title: 'Campus profile views',
      body: `${viewerCount} people from your college viewed your profile`,
    };
  }

  if (sameCollegeCount > 0) {
    const othersCount = viewerCount - 1;
    return {
      title: 'Profile views',
      body: othersCount > 1
        ? `Someone from your college and ${othersCount} others viewed your profile`
        : 'Someone from your college and someone else viewed your profile',
    };
  }

  return {
    title: 'Profile views',
    body: `${viewerCount} people viewed your profile`,
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
  async createNotification(params: CreateNotificationParams): Promise<boolean> {
    const { userId, type, title, body, actorId, postId, reelId, commentId, messageId, data } = params;

    // Don't notify yourself
    if (actorId && actorId === userId) {
      return false;
    }
    if (actorId && await areUsersBlocked(actorId, userId)) {
      return false;
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
      return true;
    } catch (error) {
      console.error('Failed to create notification:', error);
      return false;
    }
  }

  async notifyProfileView(
    userId: string,
    viewer: {
      id: string;
      name: string;
      sameCollege?: boolean;
    }
  ): Promise<void> {
    const viewerId = viewer?.id;
    if (!userId || !viewerId || userId === viewerId) {
      return;
    }
    if (await areUsersBlocked(viewerId, userId)) {
      return;
    }

    const now = new Date();
    const normalizedViewerName = normalizeProfileViewViewerName(viewer.name);
    const sameCollege = !!viewer.sameCollege;

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
            { id: viewerId, name: normalizedViewerName, sameCollege },
            ...parsed.viewers,
          ].slice(0, PROFILE_VIEW_BATCH_LIMIT);
          const copy = buildProfileViewNotificationCopy(viewers);
          const sameCollegeCount = viewers.filter((entry) => entry.sameCollege).length;
          const data = {
            screen: 'profile_views',
            batchKey: parsed.batchKey,
            windowStartedAt: parsed.windowStartedAt.toISOString(),
            lastViewedAt: now.toISOString(),
            viewerCount: viewers.length,
            sameCollegeCount,
            sameCollegeHint: sameCollege,
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
        const viewers = [{ id: viewerId, name: normalizedViewerName, sameCollege }];
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
              screen: 'profile_views',
              batchKey,
              windowStartedAt: now.toISOString(),
              lastViewedAt: now.toISOString(),
              viewerCount: 1,
              sameCollegeCount: sameCollege ? 1 : 0,
              sameCollegeHint: sameCollege,
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

  async notifyRecommendedMatch(
    userId: string,
    actorId: string,
    title: string,
    body: string,
    data: Record<string, any> = {}
  ): Promise<void> {
    await this.createNotification({
      userId,
      type: 'recommended_match',
      title,
      body,
      actorId,
      data: {
        screen: 'find_people',
        tab: 'smart_matches',
        ...data,
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

  async notifyIdentityVerificationApproved(
    userId: string,
    verificationId: string,
    trustLevel: string
  ): Promise<void> {
    const title = 'Student verification approved';
    const body = 'Your Vormex student verification is successful. Claim your green student badge from Vormex.';

    await this.createNotification({
      userId,
      type: 'identity_verification_approved',
      title,
      body,
      data: {
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        trustLevel,
        badge: 'verified',
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'identity_verification_approved',
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        trustLevel,
        badge: 'verified',
      },
    }).catch(() => undefined);
  }

  async notifyIdentityVerificationResubmitRequested(
    userId: string,
    verificationId: string,
    reason: string
  ): Promise<void> {
    const title = 'Student verification needs resubmission';
    const body = reason
      ? `Vormex could not verify this submission. Comment: ${reason}`
      : 'Vormex could not verify this submission. Please resubmit your proof.';

    await this.createNotification({
      userId,
      type: 'identity_verification_resubmit_requested',
      title,
      body,
      data: {
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        reason,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'identity_verification_resubmit_requested',
        branding: 'vormex',
        senderType: 'vormex',
        verificationId,
        reason,
      },
    }).catch(() => undefined);
  }

  async notifyHackathonTeamMatch(
    userId: string,
    actorId: string,
    params: {
      ownerName: string;
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      skills?: string[];
    }
  ): Promise<void> {
    const skillText = params.skills?.length
      ? ` for ${params.skills.slice(0, 2).join(', ')}`
      : '';

    const title = 'Team looking for your skills';
    const body = `${params.ownerName} is forming a ${params.hackathonTitle} team${skillText}`;

    await this.createNotification({
      userId,
      type: 'hackathon_team_match',
      title,
      body,
      actorId,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        skills: params.skills || [],
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_team_match',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        actorId,
      },
    }).catch(() => undefined);
  }

  async notifyNewHackathonMatch(
    userId: string,
    params: {
      hackathonId: string;
      hackathonTitle: string;
      source?: string | null;
      skills?: string[];
      startsAt?: Date | string | null;
      deadline?: Date | string | null;
      actorId?: string | null;
    }
  ): Promise<void> {
    const skillText = params.skills?.length
      ? ` Matches ${params.skills.slice(0, 2).join(', ')}.`
      : '';
    const sourceText = params.source ? `${params.source} ` : '';
    const title = 'New hackathon for you';
    const body = `${sourceText}${params.hackathonTitle} just opened.${skillText}`.slice(0, 220);

    await this.createNotification({
      userId,
      type: 'hackathon_new_match',
      title,
      body,
      actorId: params.actorId || undefined,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        source: params.source || null,
        skills: params.skills || [],
        startsAt: params.startsAt instanceof Date ? params.startsAt.toISOString() : params.startsAt || null,
        deadline: params.deadline instanceof Date ? params.deadline.toISOString() : params.deadline || null,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_new_match',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        source: params.source || '',
        actorId: params.actorId || '',
      },
    }).catch(() => undefined);
  }

  async notifyHackathonTeamApplication(
    userId: string,
    actorId: string,
    params: {
      applicantName: string;
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      applicationId: string;
    }
  ): Promise<void> {
    const title = 'New teammate application';
    const body = `${params.applicantName} applied to join your ${params.hackathonTitle} team`;

    await this.createNotification({
      userId,
      type: 'hackathon_team_application',
      title,
      body,
      actorId,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        applicationId: params.applicationId,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_team_application',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        applicationId: params.applicationId,
        actorId,
      },
    }).catch(() => undefined);
  }

  async notifyHackathonTeamApplicationAccepted(
    userId: string,
    actorId: string,
    params: {
      hackathonTitle: string;
      teamId: string;
      hackathonId: string;
      groupId?: string | null;
    }
  ): Promise<void> {
    const title = 'You are on the team';
    const body = `Your ${params.hackathonTitle} team application was accepted`;

    await this.createNotification({
      userId,
      type: 'hackathon_team_application_accepted',
      title,
      body,
      actorId,
      data: {
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        groupId: params.groupId || null,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_team_application_accepted',
        screen: 'hackathons',
        hackathonId: params.hackathonId,
        teamId: params.teamId,
        groupId: params.groupId || '',
        actorId,
      },
    }).catch(() => undefined);
  }

  async notifyHackathonWeeklyDigest(
    userId: string,
    count: number,
    sampleTitles: string[] = []
  ): Promise<void> {
    const body = count === 1
      ? `${sampleTitles[0] || 'A new hackathon'} was posted this week`
      : `${count} new hackathons were posted this week`;

    const title = 'New hackathons this week';

    await this.createNotification({
      userId,
      type: 'hackathon_weekly_digest',
      title,
      body,
      data: {
        screen: 'hackathons',
        count,
        sampleTitles,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'hackathon_weekly_digest',
        screen: 'hackathons',
        count: String(count),
      },
    }).catch(() => undefined);
  }

  async notifySkillEndorsement(
    userId: string,
    actorId: string,
    params: {
      endorserName: string;
      skillName: string;
      endorsementId: string;
    }
  ): Promise<void> {
    const title = 'New skill endorsement';
    const body = `${params.endorserName} endorsed you for ${params.skillName}`;

    await this.createNotification({
      userId,
      type: 'skill_endorsement',
      title,
      body,
      actorId,
      data: {
        screen: 'skill_passport',
        skillName: params.skillName,
        endorsementId: params.endorsementId,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_endorsement',
        screen: 'skill_passport',
        skillName: params.skillName,
        endorsementId: params.endorsementId,
        actorId,
      },
    }).catch(() => undefined);
  }

  async notifySkillSwapRequest(
    userId: string,
    requesterId: string,
    params: {
      requesterName: string;
      requestId: string;
      skillName: string;
      mode: string;
      sessionLengthMinutes?: number;
    }
  ): Promise<void> {
    const title = 'Skill Swap request';
    const body = params.mode === 'teach'
      ? `${params.requesterName} offered to help you with ${params.skillName}`
      : `${params.requesterName} asked to learn ${params.skillName} from you`;
    const data = {
      screen: 'skill_swap',
      tab: 'requests',
      requestId: params.requestId,
      skillName: params.skillName,
      mode: params.mode,
      sessionLengthMinutes: String(params.sessionLengthMinutes || ''),
    };

    await this.createNotification({
      userId,
      type: 'skill_swap_request',
      title,
      body,
      actorId: requesterId,
      data,
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_swap_request',
        actorId: requesterId,
        ...data,
      },
    }).catch(() => undefined);
  }

  async notifySkillSwapAccepted(
    userId: string,
    accepterId: string,
    params: {
      accepterName: string;
      requestId: string;
      sessionId: string;
      skillName: string;
      sessionLengthMinutes?: number;
    }
  ): Promise<void> {
    const title = 'Skill Swap accepted';
    const body = `${params.accepterName} accepted your ${params.skillName} swap`;
    const data = {
      screen: 'skill_swap',
      tab: 'sessions',
      requestId: params.requestId,
      sessionId: params.sessionId,
      skillName: params.skillName,
      sessionLengthMinutes: String(params.sessionLengthMinutes || ''),
    };

    await this.createNotification({
      userId,
      type: 'skill_swap_accepted',
      title,
      body,
      actorId: accepterId,
      data,
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_swap_accepted',
        actorId: accepterId,
        ...data,
      },
    }).catch(() => undefined);
  }

  async notifySkillSwapCompleted(
    userId: string,
    actorId: string,
    params: {
      actorName: string;
      sessionId: string;
      requestId: string;
      skillName: string;
    }
  ): Promise<void> {
    const title = 'Skill Swap completed';
    const body = `${params.actorName} completed your ${params.skillName} session`;
    const data = {
      screen: 'skill_swap',
      tab: 'sessions',
      requestId: params.requestId,
      sessionId: params.sessionId,
      skillName: params.skillName,
    };

    await this.createNotification({
      userId,
      type: 'skill_swap_completed',
      title,
      body,
      actorId,
      data,
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'skill_swap_completed',
        actorId,
        ...data,
      },
    }).catch(() => undefined);
  }

  async notifyCollegeCommunityJoined(
    userId: string,
    actorId: string,
    params: {
      memberName: string;
      college: string;
      communityId: string;
      groupId: string;
    }
  ): Promise<void> {
    const title = 'College community grew';
    const body = `${params.memberName} joined ${params.college}`;

    await this.createNotification({
      userId,
      type: 'college_community_joined',
      title,
      body,
      actorId,
      data: {
        screen: 'college_communities',
        communityId: params.communityId,
        groupId: params.groupId,
      },
    });
    pushNotificationService.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'college_community_joined',
        screen: 'college_communities',
        communityId: params.communityId,
        groupId: params.groupId,
        actorId,
      },
    }).catch(() => undefined);
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
    const notificationCreated = await this.createNotification({
      userId: postAuthorId,
      type: 'comment',
      title: '💬 New Comment',
      body: `${commenterName} commented: "${commentPreview.slice(0, 50)}${commentPreview.length > 50 ? '...' : ''}"`,
      actorId: commenterId,
      postId,
      commentId,
      data: { commentPreview },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(postAuthorId, {
      title: 'New Comment',
      body: `${commenterName} commented: "${commentPreview.slice(0, 50)}${commentPreview.length > 50 ? '...' : ''}"`,
      data: {
        type: 'comment',
        screen: 'post',
        actorId: commenterId,
        postId,
        commentId,
      },
    }).catch(() => undefined);
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
    const notificationCreated = await this.createNotification({
      userId: originalCommenterId,
      type: 'comment_reply',
      title: '↩️ New Reply',
      body: `${replierName} replied: "${replyPreview.slice(0, 50)}${replyPreview.length > 50 ? '...' : ''}"`,
      actorId: replierId,
      postId,
      commentId,
      data: { replyPreview },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(originalCommenterId, {
      title: 'New Reply',
      body: `${replierName} replied: "${replyPreview.slice(0, 50)}${replyPreview.length > 50 ? '...' : ''}"`,
      data: {
        type: 'comment_reply',
        screen: 'post',
        actorId: replierId,
        postId,
        commentId,
      },
    }).catch(() => undefined);
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
    const notificationCreated = await this.createNotification({
      userId: postAuthorId,
      type: 'like',
      title: '❤️ New Like',
      body: `${likerName} liked your post`,
      actorId: likerId,
      postId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(postAuthorId, {
      title: 'New Like',
      body: `${likerName} liked your post`,
      data: {
        type: 'like',
        screen: 'post',
        actorId: likerId,
        postId,
      },
    }).catch(() => undefined);
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
    const notificationCreated = await this.createNotification({
      userId: postAuthorId,
      type: 'post_share',
      title: '🔗 Post Shared',
      body: `${sharerName} shared your post`,
      actorId: sharerId,
      postId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(postAuthorId, {
      title: 'Post Shared',
      body: `${sharerName} shared your post`,
      data: {
        type: 'post_share',
        screen: 'post',
        actorId: sharerId,
        postId,
      },
    }).catch(() => undefined);
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
    preview: string,
    metadata: {
      commentId?: string;
      parentCommentId?: string;
    } = {}
  ): Promise<void> {
    const typeMap = {
      post: 'mention' as NotificationType,
      comment: 'mention' as NotificationType,
      reel: 'reel_mention' as NotificationType,
      reel_comment: 'reel_mention' as NotificationType,
    };
    const type = typeMap[context];
    const isReelContext = context === 'reel' || context === 'reel_comment';
    const title = '📢 You were mentioned';
    const body = `${mentionerName} mentioned you: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`;
    const data = {
      type,
      screen: isReelContext ? 'reel' : 'post',
      context,
      preview,
      actorId: mentionerId,
      ...(isReelContext ? { reelId: referenceId } : { postId: referenceId }),
      ...(metadata.commentId ? { commentId: metadata.commentId } : {}),
      ...(metadata.parentCommentId ? { parentCommentId: metadata.parentCommentId } : {}),
    };

    await this.createNotification({
      userId: mentionedUserId,
      type,
      title,
      body,
      actorId: mentionerId,
      postId: context === 'post' || context === 'comment' ? referenceId : undefined,
      reelId: context === 'reel' || context === 'reel_comment' ? referenceId : undefined,
      commentId: metadata.commentId,
      data,
    });

    pushNotificationService.sendToUser(mentionedUserId, {
      title,
      body,
      data: Object.fromEntries(
        Object.entries(data)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ),
    }).catch(() => undefined);
  }

  async notifyPostCollabInvite(
    collaboratorUserId: string,
    inviterId: string,
    inviterName: string,
    postId: string,
    preview: string
  ): Promise<void> {
    const title = '🤝 Collab invite';
    const body = `${inviterName} invited you to collaborate on a post`;
    const data = {
      type: 'mention',
      screen: 'post',
      context: 'post_collab_invite',
      collabStatus: 'pending',
      preview,
      actorId: inviterId,
      postId,
    };

    await this.createNotification({
      userId: collaboratorUserId,
      type: 'mention',
      title,
      body,
      actorId: inviterId,
      postId,
      data,
    });

    pushNotificationService.sendToUser(collaboratorUserId, {
      title,
      body,
      data: Object.fromEntries(
        Object.entries(data)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      ),
    }).catch(() => undefined);
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
    const notificationCreated = await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_like',
      title: '❤️ New Like on Reel',
      body: `${likerName} liked your reel`,
      actorId: likerId,
      reelId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(reelAuthorId, {
      title: 'New Like on Reel',
      body: `${likerName} liked your reel`,
      data: {
        type: 'reel_like',
        screen: 'reel',
        actorId: likerId,
        reelId,
      },
    }).catch(() => undefined);
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
    const preview = String(commentPreview || '').trim() || 'your reel';
    const title = '💬 New Comment on Reel';
    const body = `${commenterName} commented: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`;
    const data = {
      type: 'reel_comment',
      screen: 'reel',
      reelId,
      commentId,
      actorId: commenterId,
      commentPreview: preview,
    };

    await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_comment',
      title,
      body,
      actorId: commenterId,
      reelId,
      commentId,
      data,
    });

    pushNotificationService.sendToUser(reelAuthorId, {
      title,
      body,
      data,
    }).catch(() => undefined);
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
    parentCommentId: string,
    replyPreview: string
  ): Promise<void> {
    const preview = String(replyPreview || '').trim() || 'your comment';
    const title = '↩️ New Reply on Reel';
    const body = `${replierName} replied: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`;
    const data = {
      type: 'reel_comment_reply',
      screen: 'reel',
      reelId,
      commentId,
      parentCommentId,
      actorId: replierId,
      replyPreview: preview,
    };

    await this.createNotification({
      userId: originalCommenterId,
      type: 'reel_comment_reply',
      title,
      body,
      actorId: replierId,
      reelId,
      commentId,
      data,
    });

    pushNotificationService.sendToUser(originalCommenterId, {
      title,
      body,
      data,
    }).catch(() => undefined);
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
    const notificationCreated = await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_share',
      title: '🔗 Reel Shared',
      body: `${sharerName} shared your reel`,
      actorId: sharerId,
      reelId,
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(reelAuthorId, {
      title: 'Reel Shared',
      body: `${sharerName} shared your reel`,
      data: {
        type: 'reel_share',
        screen: 'reel',
        actorId: sharerId,
        reelId,
      },
    }).catch(() => undefined);
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

    const notificationCreated = await this.createNotification({
      userId: reelAuthorId,
      type: 'reel_view_milestone',
      title: '🎉 Milestone Reached!',
      body: `Your reel reached ${milestoneText} views!`,
      reelId,
      data: { viewCount },
    });

    if (!notificationCreated) return;

    pushNotificationService.sendToUser(reelAuthorId, {
      title: 'Milestone Reached!',
      body: `Your reel reached ${milestoneText} views!`,
      data: {
        type: 'reel_view_milestone',
        screen: 'reel',
        reelId,
        viewCount: String(viewCount),
      },
    }).catch(() => undefined);
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
