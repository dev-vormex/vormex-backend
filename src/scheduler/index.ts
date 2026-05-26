import { getQueue, isQueueingEnabled } from '../infrastructure/queue/queues';
import { queueNames } from '../infrastructure/queue/queue-names';
import { isRedisRequired } from '../infrastructure/redis/client';
import { logger } from '../lib/logger';
import { maintenanceSchedules } from '../services/cron.service';

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
      every: 60_000,
    },
    {
      name: 'scheduled_publish_tick',
      data: {},
    }
  );

  await getQueue(queueNames.peopleYouKnow).upsertJobScheduler(
    'people_you_know_flush',
    {
      every: 60_000,
    },
    {
      name: 'people_you_know_flush',
      data: {},
    }
  );

  await getQueue(queueNames.maintenance).upsertJobScheduler(
    'outbox_dispatch_tick',
    {
      every: 2_000,
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
