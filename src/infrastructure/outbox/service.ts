import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { OutboxEventInput } from './types';

type OutboxTxClient = PrismaClient | Prisma.TransactionClient;

export async function enqueueOutboxEvent(
  tx: OutboxTxClient,
  event: OutboxEventInput
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`
      INSERT INTO outbox_events (
        id,
        "aggregateType",
        "aggregateId",
        "eventType",
        "queueName",
        "idempotencyKey",
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
        ${event.idempotencyKey || null},
        ${JSON.stringify(event.payload)}::jsonb,
        ${event.availableAt || new Date()},
        NOW()
      )
      ON CONFLICT ("idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
      DO NOTHING
    `
  );
}
