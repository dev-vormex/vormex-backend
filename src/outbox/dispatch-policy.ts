import { queueNames } from '../infrastructure/queue/queue-names';
import type { QueueName } from '../infrastructure/queue/queue-names';

export type OutboxDispatchAction = 'dispatch' | 'expire' | 'quarantine';

export interface OutboxDispatchClassification {
  action: OutboxDispatchAction;
  reason: string;
  ageMs: number;
  maxAgeMs?: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const REALTIME_MAX_AGE_MS = parsePositiveInt(
  process.env.OUTBOX_REALTIME_MAX_AGE_MS,
  5 * 60 * 1_000
);
const CACHE_INVALIDATION_MAX_AGE_MS = parsePositiveInt(
  process.env.OUTBOX_CACHE_INVALIDATION_MAX_AGE_MS,
  60 * 60 * 1_000
);
const NOTIFICATION_MAX_AGE_MS = parsePositiveInt(
  process.env.OUTBOX_NOTIFICATION_MAX_AGE_MS,
  24 * 60 * 60 * 1_000
);
const ANALYTICS_MAX_AGE_MS = parsePositiveInt(
  process.env.OUTBOX_ANALYTICS_MAX_AGE_MS,
  7 * 24 * 60 * 60 * 1_000
);
const UNKNOWN_HISTORICAL_MAX_AGE_MS = parsePositiveInt(
  process.env.OUTBOX_UNKNOWN_HISTORICAL_MAX_AGE_MS,
  24 * 60 * 60 * 1_000
);

const durableQueues = new Set<QueueName>([
  queueNames.connectionSideEffects,
  queueNames.mediaProcessing,
  queueNames.scheduledPublish,
]);

const expiringQueueMaxAges = new Map<QueueName, number>([
  [queueNames.realtimeFanout, REALTIME_MAX_AGE_MS],
  [queueNames.cacheInvalidation, CACHE_INVALIDATION_MAX_AGE_MS],
  [queueNames.notificationDelivery, NOTIFICATION_MAX_AGE_MS],
  [queueNames.analyticsEvents, ANALYTICS_MAX_AGE_MS],
]);

/**
 * Prevent an old outbox backlog from replaying stale realtime events, push
 * notifications, or cache churn. Durable business side effects remain
 * dispatchable; unclassified historical work is held for manual review.
 */
export function classifyOutboxEventForDispatch(
  event: { queueName: QueueName; createdAt: Date | string },
  nowMs = Date.now()
): OutboxDispatchClassification {
  const createdAtMs = new Date(event.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return {
      action: 'quarantine',
      reason: 'invalid_created_at',
      ageMs: 0,
    };
  }

  const ageMs = Math.max(0, nowMs - createdAtMs);
  if (durableQueues.has(event.queueName)) {
    return {
      action: 'dispatch',
      reason: 'durable_queue',
      ageMs,
    };
  }

  const maxAgeMs = expiringQueueMaxAges.get(event.queueName);
  if (maxAgeMs !== undefined) {
    return ageMs <= maxAgeMs
      ? { action: 'dispatch', reason: 'within_delivery_window', ageMs, maxAgeMs }
      : { action: 'expire', reason: 'delivery_window_elapsed', ageMs, maxAgeMs };
  }

  if (ageMs > UNKNOWN_HISTORICAL_MAX_AGE_MS) {
    return {
      action: 'quarantine',
      reason: 'historical_queue_requires_review',
      ageMs,
      maxAgeMs: UNKNOWN_HISTORICAL_MAX_AGE_MS,
    };
  }

  return {
    action: 'dispatch',
    reason: 'fresh_unclassified_queue',
    ageMs,
    maxAgeMs: UNKNOWN_HISTORICAL_MAX_AGE_MS,
  };
}
