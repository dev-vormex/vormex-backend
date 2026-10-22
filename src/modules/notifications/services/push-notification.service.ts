import { prisma } from '../../../config/prisma';
import type { MulticastMessage } from 'firebase-admin/messaging';
import { getFirebaseMessaging, initializeFirebaseAdmin } from '../../../infrastructure/firebase/firebase-admin.service';
import { logger } from '../../../infrastructure/logging/logger';
import { pushNotificationConfigCounter } from '../../../infrastructure/metrics/registry';
import { getNotificationPreferences } from './preferences.service';
import { isNotificationQuietTime, notificationCategoryEnabled } from './preferences-policy.service';

/**
 * Push Notification Service
 * 
 * To enable Firebase Cloud Messaging:
 * 1. Install firebase-admin: npm install firebase-admin
 * 2. Set environment variables:
 *    - FIREBASE_PROJECT_ID
 *    - FIREBASE_CLIENT_EMAIL
 *    - FIREBASE_PRIVATE_KEY (with \n for newlines)
 * 3. Uncomment the Firebase imports and initialization below
 */

interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

interface ReengagementPushPayload {
  title: string;
  body: string;
  campaignType: 'match' | 'growth' | 'streak';
  data?: Record<string, string>;
}

interface ProfileViewPushPayload {
  title: string;
  body: string;
  viewerId: string;
  batchKey: string;
  viewerCount: number;
}

interface RecommendedMatchPushData {
  actorId?: string;
  matchReason?: string;
  matchScore?: string;
  matchUserId?: string;
  screen?: string;
  source?: string;
  tab?: string;
  whySummary?: string;
}

type PushNotificationMode = 'firebase' | 'disabled' | 'mock';

let pushMode: PushNotificationMode = 'disabled';

function hasFirebaseCredentials(): boolean {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isPushExplicitlyDisabled(): boolean {
  return process.env.PUSH_NOTIFICATIONS_ENABLED === 'false';
}

function isExplicitMockMode(): boolean {
  return process.env.FIREBASE_PUSH_MOCK_MODE === 'true' && !isProduction();
}

export function resolvePushNotificationMode(): PushNotificationMode {
  if (isPushExplicitlyDisabled()) {
    pushNotificationConfigCounter.inc({ state: 'disabled' });
    logger.error({
      event: 'push_notifications.disabled',
      reason: 'PUSH_NOTIFICATIONS_ENABLED=false',
    });
    return 'disabled';
  }

  if (!hasFirebaseCredentials()) {
    if (isExplicitMockMode()) {
      pushNotificationConfigCounter.inc({ state: 'mock' });
      logger.warn({
        event: 'push_notifications.mock_enabled',
        reason: 'FIREBASE_PUSH_MOCK_MODE=true',
      });
      return 'mock';
    }

    pushNotificationConfigCounter.inc({ state: 'missing_config' });
    const message =
      'Firebase Admin credentials are missing. Configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY, set PUSH_NOTIFICATIONS_ENABLED=false to disable push, or set FIREBASE_PUSH_MOCK_MODE=true in dev/test only.';

    if (isProduction()) {
      logger.fatal({
        event: 'push_notifications.config_missing',
      }, message);
      throw new Error(message);
    }

    logger.error({
      event: 'push_notifications.disabled',
      reason: 'firebase_config_missing',
    }, message);
    return 'disabled';
  }

  const initialized = initializeFirebaseAdmin();
  if (initialized) {
    pushNotificationConfigCounter.inc({ state: 'firebase' });
    return 'firebase';
  }

  pushNotificationConfigCounter.inc({ state: 'invalid_config' });
  const message = 'Firebase Admin failed to initialize. Push notifications are not safe to send.';
  if (isProduction()) {
    logger.fatal({
      event: 'push_notifications.config_invalid',
    }, message);
    throw new Error(message);
  }

  if (isExplicitMockMode()) {
    pushNotificationConfigCounter.inc({ state: 'mock' });
    logger.warn({
      event: 'push_notifications.mock_enabled',
      reason: 'firebase_initialize_failed',
    });
    return 'mock';
  }

  logger.error({
    event: 'push_notifications.disabled',
    reason: 'firebase_initialize_failed',
  }, message);
  return 'disabled';
}

export class PushNotificationService {
  constructor() {
    pushMode = resolvePushNotificationMode();
  }

  async sendToUser(userId: string, payload: NotificationPayload): Promise<boolean> {
    try {
      const settings = await getNotificationPreferences(userId);
      if (!settings.pushEnabled || !notificationCategoryEnabled(settings, payload.data?.type ?? '') || isNotificationQuietTime(settings)) {
        return false;
      }
      if (pushMode === 'mock') {
        logger.warn({
          event: 'push_notification.mock_send',
          userId,
          title: payload.title,
          hasData: Boolean(payload.data),
        });
        return true;
      }

      if (pushMode === 'disabled') {
        logger.error({
          event: 'push_notification.disabled_drop',
          userId,
          title: payload.title,
        }, 'Push notification was not sent because Firebase push is disabled.');
        return false;
      }

      const tokens = await prisma.device_tokens.findMany({
        where: { userId, isActive: true },
        select: { id: true, token: true },
      });

      if (tokens.length === 0) {
        console.log(`No active device tokens for user ${userId}`);
        return false;
      }

      // Send via Firebase Cloud Messaging
      const messaging = getFirebaseMessaging();
      if (!messaging) {
        logger.error({
          event: 'push_notification.messaging_unavailable',
          userId,
          title: payload.title,
        }, 'Firebase messaging is unavailable; push notification was not sent.');
        return false;
      }
      const tokenStrings = tokens.map(t => t.token);
      
      // IMPORTANT: Use DATA-ONLY messages (no 'notification' field)
      // This ensures onMessageReceived() is ALWAYS called, even when app is killed
      // The Android app handles displaying the notification itself
      const message: MulticastMessage = {
        tokens: tokenStrings,
        // NO notification field - this is intentional for background delivery
        data: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
          ...(payload.data || {}),
        },
        android: {
          // HIGH priority ensures delivery even when app is killed/doze mode
          priority: 'high',
          ttl: 86400000, // 24 hours time-to-live
        },
        apns: {
          headers: {
            'apns-priority': '10', // Immediate delivery
            'apns-push-type': 'alert',
          },
          payload: {
            aps: {
              'content-available': 1, // Enable background processing
              alert: {
                title: payload.title,
                body: payload.body,
              },
              sound: 'default',
              badge: 1,
            },
          },
        },
        webpush: {
          headers: {
            Urgency: 'high',
          },
          data: {
            title: payload.title,
            body: payload.body,
          },
        },
      };

      const response = await messaging.sendEachForMulticast(message);
      
      console.log(`📱 Push notification sent to ${userId}: ${response.successCount}/${tokens.length} successful`);

      if (response.failureCount > 0) {
        const failedTokenIds: string[] = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorCode = resp.error?.code;
            if (
              errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered'
            ) {
              failedTokenIds.push(tokens[idx].id);
            }
            console.error(`Token ${idx} failed:`, resp.error?.message);
          }
        });

        if (failedTokenIds.length > 0) {
          await prisma.device_tokens.updateMany({
            where: { id: { in: failedTokenIds } },
            data: { isActive: false },
          });
          console.log(`Deactivated ${failedTokenIds.length} invalid tokens`);
        }
      }

      return response.successCount > 0;
    } catch (error) {
      console.error('Error sending push notification:', error);
      return false;
    }
  }

  async sendToMultipleUsers(userIds: string[], payload: NotificationPayload): Promise<number> {
    let successCount = 0;
    const batchSize = 10;

    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(userId => this.sendToUser(userId, payload))
      );
      successCount += results.filter(Boolean).length;
    }

    return successCount;
  }

  async pushRecommendedMatch(
    userId: string,
    title: string,
    body: string,
    data: RecommendedMatchPushData = {}
  ): Promise<boolean> {
    return this.sendToUser(userId, {
      title,
      body,
      data: {
        type: 'recommended_match',
        screen: 'find_people',
        tab: 'smart_matches',
        ...data,
      },
    });
  }

  async pushReengagementNudge(userId: string, payload: ReengagementPushPayload): Promise<boolean> {
    const type = payload.campaignType === 'streak' ? 'streak_at_risk' : 'daily_match';
    const screen = payload.campaignType === 'streak' ? 'engagement' : 'find_people';

    return this.sendToUser(userId, {
      title: payload.title,
      body: payload.body,
      data: {
        type,
        screen,
        ...(payload.data || {}),
      },
    });
  }

  async pushStreakAtRisk(userId: string, streakCount: number, streakType: string = 'activity'): Promise<boolean> {
    return this.sendToUser(userId, {
      title: '🔥 Your Streak is at Risk!',
      body: `Don't lose your ${streakCount}-day ${streakType} streak! Open the app now to keep it going`,
      data: {
        type: 'streak_at_risk',
        streakCount: String(streakCount),
        streakType,
        screen: 'engagement',
      },
    });
  }

  async pushConnectionAccepted(
    userId: string,
    accepterName: string,
    connectionId: string,
    accepterId?: string
  ): Promise<boolean> {
    return this.sendToUser(userId, {
      title: '✅ Connection Accepted',
      body: `${accepterName} accepted your connection request`,
      data: {
        type: 'connection_accepted',
        connectionId,
        ...(accepterId ? { actorId: accepterId } : {}),
        screen: 'connection_celebration',
      },
    });
  }

  async pushConnectionRequest(userId: string, requesterName: string, connectionId: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: '👋 Someone wants to connect!',
      body: `${requesterName} is interested in your profile`,
      data: {
        type: 'connection_request',
        connectionId,
        screen: 'connections',
      },
    });
  }

  async pushNewMessage(
    userId: string,
    senderName: string,
    preview: string,
    conversationId: string,
    senderId?: string,
    senderImage?: string,
    message?: {
      id?: string;
      clientMessageId?: string;
      content?: string;
      contentType?: string;
      mediaUrl?: string | null;
      mediaType?: string | null;
      fileName?: string | null;
      fileSize?: number | null;
      createdAt?: string | Date;
      updatedAt?: string | Date;
    }
  ): Promise<boolean> {
    const messageCreatedAt =
      message?.createdAt instanceof Date ? message.createdAt.toISOString() : message?.createdAt;
    const messageUpdatedAt =
      message?.updatedAt instanceof Date ? message.updatedAt.toISOString() : message?.updatedAt;

    return this.sendToUser(userId, {
      title: senderName,
      body: preview.length > 100 ? preview.substring(0, 97) + '...' : preview,
      data: {
        type: 'new_message',
        conversationId,
        user_id: senderId || '',
        senderName,
        senderImage: senderImage || '',
        messageId: message?.id || '',
        clientMessageId: message?.clientMessageId || '',
        messageContent: message?.content || preview || '',
        contentType: message?.contentType || 'text',
        mediaUrl: message?.mediaUrl || '',
        mediaType: message?.mediaType || '',
        fileName: message?.fileName || '',
        fileSize: message?.fileSize != null ? String(message.fileSize) : '',
        messageCreatedAt: messageCreatedAt || '',
        messageUpdatedAt: messageUpdatedAt || messageCreatedAt || '',
        screen: 'chat',
      },
    });
  }

  async pushGroupMessage(
    userId: string,
    groupName: string,
    senderName: string,
    preview: string,
    groupId: string,
    senderId?: string,
    groupImage?: string,
    senderImage?: string
  ): Promise<boolean> {
    const messagePreview = preview.length > 100 ? preview.substring(0, 97) + '...' : preview;

    return this.sendToUser(userId, {
      title: groupName,
      body: `${senderName}: ${messagePreview}`,
      imageUrl: groupImage,
      data: {
        type: 'group_message',
        groupId,
        groupName,
        groupImage: groupImage || '',
        senderId: senderId || '',
        senderName,
        senderImage: senderImage || '',
        messagePreview,
        screen: 'group_chat',
      },
    });
  }

  async pushGroupMessageToUsers(
    userIds: string[],
    groupName: string,
    senderName: string,
    preview: string,
    groupId: string,
    senderId?: string,
    groupImage?: string,
    senderImage?: string
  ): Promise<number> {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    let successCount = 0;

    for (const userId of uniqueUserIds) {
      const sent = await this.pushGroupMessage(
        userId,
        groupName,
        senderName,
        preview,
        groupId,
        senderId,
        groupImage,
        senderImage
      );
      if (sent) {
        successCount++;
      }
    }

    return successCount;
  }

  async pushStudyGroupInvite(userId: string, groupName: string, inviterName: string, groupId: string): Promise<boolean> {
    return this.sendToUser(userId, {
      title: '📚 Study Group Invite',
      body: `${inviterName} invited you to join "${groupName}"`,
      data: {
        type: 'study_group_invite',
        groupId,
        screen: 'groups',
      },
    });
  }

  async pushProfileView(userId: string, payload: ProfileViewPushPayload): Promise<boolean> {
    return this.sendToUser(userId, {
      title: payload.title,
      body: payload.body,
      data: {
        type: 'profile_view',
        viewerId: payload.viewerId,
        actorId: payload.viewerId,
        notificationBatchKey: payload.batchKey,
        viewerCount: String(payload.viewerCount),
        screen: 'profile_views',
      },
    });
  }

  async pushPeopleYouKnowJoined(userId: string, count: number): Promise<boolean> {
    const body =
      count > 1 ? `${count} contacts just joined Vormex` : 'A contact just joined Vormex';

    return this.sendToUser(userId, {
      title: 'People You Know',
      body,
      data: {
        type: 'people_you_know_joined',
        count: String(count),
        screen: 'find_people',
        tab: 'people_you_know',
      },
    });
  }

  async pushAdminAnnouncement(
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string> = {}
  ): Promise<number> {
    return this.sendToMultipleUsers(userIds, {
      title,
      body,
      data: {
        type: 'admin_announcement',
        senderType: 'admin',
        branding: 'vormex',
        screen: 'engagement',
        ...data,
      },
    });
  }
}

export const pushNotificationService = new PushNotificationService();
