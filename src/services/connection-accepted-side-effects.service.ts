import { prisma } from '../config/prisma';
import { publishRealtimeEnvelope } from '../infrastructure/realtime/channels';
import type { ConnectionAcceptedSideEffectsPayload } from '../outbox/types';
import { updateEngagementStreak } from '../controllers/engagement.controller';
import { recordActivity } from './activity.service';
import { cacheService } from './cache.service';
import { notificationService } from './notification.service';
import { pushNotificationService } from './push-notification.service';
import { recordAuthoritativeRecommendationOutcome } from './recommendation-platform.service';

const TOP_NETWORKERS_CACHE_TAG = 'engagement:leaderboard';

function discoveryCacheTags(userIds: string[]): string[] {
  return Array.from(new Set([
    TOP_NETWORKERS_CACHE_TAG,
    ...userIds.flatMap((userId) => [
      `people:user:${userId}`,
      `people:connections:${userId}`,
      `matching:user:${userId}`,
      `user:${userId}`,
    ]),
  ]));
}

async function refreshConnectionCount(userId: string): Promise<void> {
  const connectionsCount = await prisma.connections.count({
    where: {
      status: 'accepted',
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
  });
  // Set the authoritative count instead of incrementing, making worker retries safe.
  await prisma.userStats.upsert({
    where: { userId },
    update: { connectionsCount },
    create: { userId, connectionsCount },
  });
}

/** Run every DB-backed side effect serially on a single-concurrency worker. */
export async function processConnectionAcceptedSideEffects(
  payload: ConnectionAcceptedSideEffectsPayload
): Promise<void> {
  const { connectionId, requesterId, addresseeId, requester, addressee } = payload;

  await refreshConnectionCount(requesterId);
  await refreshConnectionCount(addresseeId);
  await recordActivity(addresseeId, 'connection', 1, {
    sourceId: connectionId,
    skipStatsUpdate: true,
  });
  await recordActivity(requesterId, 'connection', 1, {
    sourceId: connectionId,
    skipStatsUpdate: true,
  });
  await recordAuthoritativeRecommendationOutcome({
    userId: requesterId,
    entityType: 'PERSON',
    entityId: addresseeId,
    eventType: 'CONNECTION_ACCEPTED',
    meaningfulOutcome: true,
    attributionWindowHours: 7 * 24,
  });
  await updateEngagementStreak(addresseeId, 'connection');
  await updateEngagementStreak(requesterId, 'connection');

  await publishRealtimeEnvelope({
    event: 'connection:accepted',
    users: [addresseeId],
    payload: { connectionId, otherUser: requester },
    dedupeKey: `connection:${connectionId}:accepted:${addresseeId}`,
  });
  await publishRealtimeEnvelope({
    event: 'connection:accepted',
    users: [requesterId],
    payload: { connectionId, otherUser: addressee },
    dedupeKey: `connection:${connectionId}:accepted:${requesterId}`,
  });
  await notificationService.notifyConnectionAccepted(
    requesterId,
    addresseeId,
    addressee.name || 'Someone'
  );
  await pushNotificationService.pushConnectionAccepted(
    requesterId,
    addressee.name || 'Someone',
    connectionId,
    addresseeId
  );
  await cacheService.invalidateTags(...discoveryCacheTags([requesterId, addresseeId]));
}
