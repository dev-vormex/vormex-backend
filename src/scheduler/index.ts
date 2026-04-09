import { getQueue } from '../infrastructure/queue/queues';
import { queueNames } from '../infrastructure/queue/queue-names';
import { maintenanceSchedules } from '../services/cron.service';

export async function registerSchedulerJobs(): Promise<void> {
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
}
