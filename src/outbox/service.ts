import { Prisma, type PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { OutboxEventInput } from './types';

type OutboxTxClient = PrismaClient | Prisma.TransactionClient;

/**
 * Insert several outbox rows with a single statement. On high-latency links
 * (pooled serverless Postgres) every statement inside the send transaction is
 * a full network round-trip, so batching matters.
 */
export async function enqueueOutboxEvents(
  tx: OutboxTxClient,
  events: OutboxEventInput[]
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  if (events.length === 1) {
    await enqueueOutboxEvent(tx, events[0]);
    return;
  }

  const values = events.map((event) =>
    Prisma.sql`(
      ${randomUUID()},
      ${event.aggregateType},
      ${event.aggregateId},
      ${event.eventType},
      ${event.queueName},
      ${event.idempotencyKey || null},
      ${JSON.stringify(event.payload)}::jsonb,
      ${event.availableAt || new Date()},
      NOW()
    )`
  );

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
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL
      DO NOTHING
    `
  );
}

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
