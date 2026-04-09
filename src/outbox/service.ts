import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { OutboxEventInput } from './types';

export async function enqueueOutboxEvent(
  tx: PrismaClient,
  event: OutboxEventInput
): Promise<void> {
  await (tx as PrismaClient).$executeRaw(
    Prisma.sql`
      INSERT INTO outbox_events (
        id,
        "aggregateType",
        "aggregateId",
        "eventType",
        "queueName",
        payload,
        "availableAt",
        "updatedAt"
      )
      VALUES (
        ${randomUUID()},
        ${event.aggregateType},
        ${event.aggregateId},
        ${event.eventType},
        ${event.queueName},
        ${JSON.stringify(event.payload)}::jsonb,
        ${event.availableAt || new Date()},
        NOW()
      )
    `
  );
}
