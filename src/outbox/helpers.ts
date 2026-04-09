import type { PrismaClient } from '@prisma/client';
import { queueNames } from '../infrastructure/queue/queue-names';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';
import type { NotificationDeliveryPayload } from './types';
import { enqueueOutboxEvent } from './service';

export async function enqueueRealtimeFanout(
  tx: PrismaClient,
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    envelopes: RealtimeEnvelope[];
  }
): Promise<void> {
  await enqueueOutboxEvent(tx, {
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    eventType: params.eventType,
    queueName: queueNames.realtimeFanout,
    payload: {
      envelopes: params.envelopes,
    },
  });
}

export async function enqueueCacheInvalidation(
  tx: PrismaClient,
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    tags: string[];
  }
): Promise<void> {
  if (params.tags.length === 0) {
    return;
  }

  await enqueueOutboxEvent(tx, {
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    eventType: params.eventType,
    queueName: queueNames.cacheInvalidation,
    payload: {
      tags: params.tags,
    },
  });
}

export async function enqueueNotificationDelivery(
  tx: PrismaClient,
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: NotificationDeliveryPayload;
  }
): Promise<void> {
  await enqueueOutboxEvent(tx, {
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    eventType: params.eventType,
    queueName: queueNames.notificationDelivery,
    payload: params.payload as unknown as Record<string, unknown>,
  });
}
