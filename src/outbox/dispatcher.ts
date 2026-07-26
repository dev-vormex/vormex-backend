import { Prisma } from '@prisma/client';
import { prismaWrite } from '../config/prisma';
import { getQueue } from '../infrastructure/queue/queues';
import type { QueueName } from '../infrastructure/queue/queue-names';
import { outboxDispatchCounter } from '../infrastructure/metrics/registry';
import { logger } from '../lib/logger';
import { classifyOutboxEventForDispatch } from './dispatch-policy';

type OutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
};

const DEFAULT_BATCH_SIZE = 50;
let warnedMissingOutboxTable = false;

function isMissingOutboxTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String((error).code || '') : '';
  const message = 'message' in error ? String((error).message || '') : '';

  return code === '42P01' || message.includes('relation "outbox_events" does not exist');
}

async function pickPendingEvents(limit: number): Promise<OutboxRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 200));
  return prismaWrite.$queryRaw<OutboxRow[]>(
    Prisma.sql`
      WITH picked AS (
        SELECT id
        FROM outbox_events
        WHERE status = 'pending'
          AND "availableAt" <= NOW()
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${boundedLimit}
      )
      UPDATE outbox_events o
      SET status = 'processing',
          "updatedAt" = NOW()
      FROM picked
      WHERE o.id = picked.id
      RETURNING o.id, o."aggregateType", o."aggregateId", o."eventType", o."queueName", o.payload, o.attempts, o."createdAt";
    `
  );
}

export async function dispatchOutboxBatch(limit = DEFAULT_BATCH_SIZE): Promise<number> {
  let events: OutboxRow[];

  try {
    events = await pickPendingEvents(limit);
  } catch (error) {
    if (isMissingOutboxTableError(error)) {
      if (!warnedMissingOutboxTable) {
        warnedMissingOutboxTable = true;
        logger.warn({
          event: 'outbox.dispatch.skipped',
          message: 'outbox_events table is missing; skipping dispatch until schema bootstrap completes.',
        });
      }
      return 0;
    }

    throw error;
  }

  if (events.length === 0) {
    return 0;
  }

  for (const event of events) {
    const classification = classifyOutboxEventForDispatch(event);
    if (classification.action !== 'dispatch') {
      const terminalStatus = classification.action === 'expire' ? 'expired' : 'quarantined';
      const reason = [
        classification.reason,
        `age_ms=${classification.ageMs}`,
        classification.maxAgeMs === undefined
          ? undefined
          : `max_age_ms=${classification.maxAgeMs}`,
      ].filter(Boolean).join(' ');

      await prismaWrite.$executeRaw(
        Prisma.sql`
          UPDATE outbox_events
          SET status = ${terminalStatus},
              "lastError" = ${reason},
              "updatedAt" = NOW()
          WHERE id = ${event.id}
        `
      );
      outboxDispatchCounter.inc({
        status: terminalStatus,
        queue: event.queueName,
      });
      logger.warn({
        event: `outbox.dispatch.${terminalStatus}`,
        outboxEventId: event.id,
        eventType: event.eventType,
        queueName: event.queueName,
        ageMs: classification.ageMs,
        reason: classification.reason,
      });
      continue;
    }

    try {
      await getQueue(event.queueName).add(
        event.eventType,
        {
          event,
        },
        {
          jobId: event.id,
        }
      );

      await prismaWrite.$executeRaw(
        Prisma.sql`
          UPDATE outbox_events
          SET status = 'published',
              "publishedAt" = NOW(),
              "updatedAt" = NOW()
          WHERE id = ${event.id}
        `
      );

      outboxDispatchCounter.inc({
        status: 'published',
        queue: event.queueName,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await prismaWrite.$executeRaw(
        Prisma.sql`
          UPDATE outbox_events
          SET status = 'pending',
              attempts = attempts + 1,
              "lastError" = ${err.message},
              "availableAt" = ${new Date(Date.now() + 5_000)},
              "updatedAt" = NOW()
          WHERE id = ${event.id}
        `
      );

      outboxDispatchCounter.inc({
        status: 'failed',
        queue: event.queueName,
      });

      logger.error({
        event: 'outbox.dispatch.failed',
        outboxEventId: event.id,
        queueName: event.queueName,
        message: err.message,
      });
    }
  }

  return events.length;
}
