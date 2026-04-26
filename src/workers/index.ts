import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { queueNames } from '../infrastructure/queue/queue-names';
import type { QueueName } from '../infrastructure/queue/queue-names';
import { getQueue } from '../infrastructure/queue/queues';
import { redisCommand } from '../infrastructure/redis/client';
import { redisCacheService } from '../infrastructure/cache/redis-cache.service';
import { publishRealtimeEnvelope } from '../infrastructure/realtime/channels';
import type {
  CacheInvalidationPayload,
  NotificationDeliveryPayload,
  RealtimeFanoutPayload,
} from '../outbox/types';
import { pushNotificationService } from '../services/push-notification.service';
import { publishScheduledReels } from '../services/scheduled-publish.service';
import { flushPendingPeopleYouKnowNotifications } from '../services/people-you-know-join.service';
import { runMaintenanceJob, type MaintenanceJobName } from '../services/cron.service';
import { dispatchOutboxBatch } from '../outbox/dispatcher';
import { logger } from '../lib/logger';
import { queueBacklogGauge } from '../infrastructure/metrics/registry';

async function processRealtimeFanout(job: Job<{ event: { payload: RealtimeFanoutPayload } }>) {
  const envelopes = job.data.event.payload.envelopes || [];
  for (const envelope of envelopes) {
    await publishRealtimeEnvelope(envelope);
  }
}

async function processNotificationDelivery(job: Job<{ event: { payload: NotificationDeliveryPayload } }>) {
  const payload = job.data.event.payload;
  if (payload.kind === 'new_message') {
    await pushNotificationService.pushNewMessage(
      payload.userId,
      payload.senderName || payload.title,
      payload.body,
      payload.conversationId || '',
      payload.senderId,
      payload.senderImage
    );
    return;
  }

  if (payload.kind === 'group_message') {
    await pushNotificationService.pushGroupMessage(
      payload.userId,
      payload.groupName || payload.title,
      payload.senderName || 'Someone',
      payload.body,
      payload.groupId || '',
      payload.senderId,
      payload.groupImage,
      payload.senderImage
    );
    return;
  }

  await pushNotificationService.sendToUser(payload.userId, {
    title: payload.title,
    body: payload.body,
    data: payload.data,
    imageUrl: payload.imageUrl,
  });
}

async function processCacheInvalidation(job: Job<{ event: { payload: CacheInvalidationPayload } }>) {
  const tags = job.data.event.payload.tags || [];
  await redisCacheService.invalidateTags(...tags);
}

async function processScheduledPublish() {
  return publishScheduledReels();
}

async function processPeopleYouKnow() {
  return flushPendingPeopleYouKnowNotifications();
}

async function processMaintenance(job: Job) {
  if (job.name === 'outbox_dispatch_tick') {
    return dispatchOutboxBatch();
  }

  return runMaintenanceJob(job.name as MaintenanceJobName);
}

function createWorker<T>(name: string, processor: (job: Job<any>) => Promise<T>): Worker {
  return new Worker(name, processor, {
    connection: redisCommand || undefined,
    concurrency: 10,
  });
}

const workers = [
  createWorker(queueNames.realtimeFanout, processRealtimeFanout),
  createWorker(queueNames.notificationDelivery, processNotificationDelivery),
  createWorker(queueNames.cacheInvalidation, processCacheInvalidation),
  createWorker(queueNames.scheduledPublish, processScheduledPublish),
  createWorker(queueNames.peopleYouKnow, processPeopleYouKnow),
  createWorker(queueNames.maintenance, processMaintenance),
];

for (const worker of workers) {
  worker.on('completed', async () => {
    const counts = await getQueue(worker.name as QueueName)
      .getJobCounts('waiting', 'delayed', 'prioritized')
      .catch(() => ({ waiting: 0, delayed: 0, prioritized: 0 }));

    queueBacklogGauge.set(
      { queue: worker.name },
      (counts.waiting || 0) + (counts.delayed || 0) + (counts.prioritized || 0)
    );
  });

  worker.on('failed', (job, error) => {
    logger.error({
      event: 'worker.failed',
      queue: worker.name,
      jobId: job?.id,
      message: error.message,
    });
  });
}

export async function startWorkers(): Promise<void> {
  logger.info({
    event: 'workers.started',
    queues: workers.map((worker) => worker.name),
  });
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.close()));
}
