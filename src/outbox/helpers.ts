import type { Prisma, PrismaClient } from '@prisma/client';
import { queueNames } from '../infrastructure/queue/queue-names';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';
import type { NotificationDeliveryPayload } from './types';
import { enqueueOutboxEvent } from './service';

type OutboxTxClient = PrismaClient | Prisma.TransactionClient;

export async function enqueueRealtimeFanout(
  tx: OutboxTxClient,
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    envelopes: RealtimeEnvelope[];
    idempotencyKey?: string;
  }
): Promise<void> {
  await enqueueOutboxEvent(tx, {
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    eventType: params.eventType,
    queueName: queueNames.realtimeFanout,
    idempotencyKey: params.idempotencyKey,
    payload: {
      envelopes: params.envelopes,
    },
  });
}

export async function enqueueCacheInvalidation(
  tx: OutboxTxClient,
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    tags: string[];
    idempotencyKey?: string;
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
    idempotencyKey: params.idempotencyKey,
    payload: {
      tags: params.tags,
    },
  });
}

export async function enqueueNotificationDelivery(
  tx: OutboxTxClient,
  params: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: NotificationDeliveryPayload;
    idempotencyKey?: string;
  }
): Promise<void> {
  await enqueueOutboxEvent(tx, {
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    eventType: params.eventType,
    queueName: queueNames.notificationDelivery,
    idempotencyKey: params.idempotencyKey,
    payload: params.payload as unknown as Record<string, unknown>,
  });
}
