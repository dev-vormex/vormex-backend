import { getQueue, isQueueingEnabled } from '../infrastructure/queue/queues';
import { queueNames } from '../infrastructure/queue/queue-names';
import { isRedisRequired } from '../infrastructure/redis/client';
import { logger } from '../lib/logger';
import { maintenanceSchedules } from '../services/cron.service';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SCHEDULED_PUBLISH_INTERVAL_MS = parsePositiveInt(
  process.env.SCHEDULED_PUBLISH_INTERVAL_MS,
  60_000
);
const PEOPLE_YOU_KNOW_INTERVAL_MS = parsePositiveInt(
  process.env.PEOPLE_YOU_KNOW_INTERVAL_MS,
  60_000
);
const OUTBOX_DISPATCH_INTERVAL_MS = parsePositiveInt(
  process.env.OUTBOX_DISPATCH_INTERVAL_MS,
  2_000
);

export async function registerSchedulerJobs(): Promise<boolean> {
  if (!isQueueingEnabled()) {
    if (isRedisRequired()) {
      throw new Error('Scheduler requires Redis, but Redis is not connected');
    }

    logger.warn({
      event: 'scheduler.skipped',
      reason: 'redis_unavailable',
    });
    return false;
  }

  await getQueue(queueNames.scheduledPublish).upsertJobScheduler(
    'scheduled_publish_tick',
    {
      every: SCHEDULED_PUBLISH_INTERVAL_MS,
    },
    {
      name: 'scheduled_publish_tick',
      data: {},
    }
  );

  await getQueue(queueNames.peopleYouKnow).upsertJobScheduler(
    'people_you_know_flush',
    {
      every: PEOPLE_YOU_KNOW_INTERVAL_MS,
    },
    {
      name: 'people_you_know_flush',
      data: {},
    }
  );

  await getQueue(queueNames.maintenance).upsertJobScheduler(
    'outbox_dispatch_tick',
    {
      every: OUTBOX_DISPATCH_INTERVAL_MS,
    },
    {
      name: 'outbox_dispatch_tick',
      data: {},
    }
  );

  for (const schedule of maintenanceSchedules) {
    await getQueue(queueNames.maintenance).upsertJobScheduler(
      schedule.schedulerId,
      {
        pattern: schedule.pattern,
      },
      {
        name: schedule.jobName,
        data: {},
      }
    );
  }

  return true;
}
