import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { prismaRead } from '../config/prisma';
import { queueNames } from '../infrastructure/queue/queue-names';
import type { QueueName } from '../infrastructure/queue/queue-names';
import { getQueue } from '../infrastructure/queue/queues';
import { isRedisEnabled, isRedisRequired, redisCommand } from '../infrastructure/redis/client';
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKER_CONCURRENCY = parsePositiveInt(process.env.WORKER_CONCURRENCY, 10);
const FOLLOWER_FEED_INVALIDATION_BATCH_SIZE = parsePositiveInt(
  process.env.FOLLOWER_FEED_INVALIDATION_BATCH_SIZE,
  5_000
);

type CacheInvalidationJobData =
  | CacheInvalidationPayload
  | {
      event?: {
        payload?: CacheInvalidationPayload;
      };
    };

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
      payload.senderImage,
      {
        id: payload.messageId,
        clientMessageId: payload.clientMessageId,
        content: payload.messageContent || payload.body,
        contentType: payload.contentType,
        mediaUrl: payload.mediaUrl,
        mediaType: payload.mediaType,
        fileName: payload.fileName,
        fileSize: payload.fileSize,
        createdAt: payload.messageCreatedAt,
        updatedAt: payload.messageUpdatedAt,
      }
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

function getCacheInvalidationPayload(job: Job<CacheInvalidationJobData>): CacheInvalidationPayload {
  const data = job.data as CacheInvalidationJobData & {
    event?: {
      payload?: CacheInvalidationPayload;
    };
  };
  return data.event?.payload || (data as CacheInvalidationPayload);
}

async function invalidateFollowerFeedCaches(authorId: string): Promise<void> {
  let cursorId: string | undefined;

  for (;;) {
    const followers = await prismaRead.follows.findMany({
      where: { followingId: authorId },
      select: { id: true, followerId: true },
      orderBy: { id: 'asc' },
      take: FOLLOWER_FEED_INVALIDATION_BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    if (followers.length === 0) {
      return;
    }

    const tags = Array.from(
      new Set(followers.map((follow) => `feed:${follow.followerId}`))
    );
    await redisCacheService.invalidateTags(...tags);

    if (followers.length < FOLLOWER_FEED_INVALIDATION_BATCH_SIZE) {
      return;
    }
    cursorId = followers[followers.length - 1].id;
  }
}

async function processCacheInvalidation(job: Job<CacheInvalidationJobData>) {
  const payload = getCacheInvalidationPayload(job);

  if ('type' in payload && payload.type === 'post_created') {
    if (!payload.postId || !payload.authorId) {
      throw new Error('Invalid post_created cache invalidation payload');
    }

    await invalidateFollowerFeedCaches(payload.authorId);
    return;
  }

  const tags = 'tags' in payload ? payload.tags || [] : [];
  await redisCacheService.invalidateTags(...tags);
}

async function processAnalyticsEvents(job: Job) {
  logger.info({
    event: 'worker.stub.analytics_events',
    queueName: queueNames.analyticsEvents,
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });
}

async function processMediaProcessing(job: Job) {
  logger.info({
    event: 'worker.stub.media_processing',
    queueName: queueNames.mediaProcessing,
    jobId: job.id,
    jobName: job.name,
    data: job.data,
  });
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
    connection: redisCommand!,
    concurrency: WORKER_CONCURRENCY,
  });
}

let workers: Worker[] = [];

function createWorkers(): Worker[] {
  if (workers.length > 0) {
    return workers;
  }

  workers = [
    createWorker(queueNames.realtimeFanout, processRealtimeFanout),
    createWorker(queueNames.notificationDelivery, processNotificationDelivery),
    createWorker(queueNames.cacheInvalidation, processCacheInvalidation),
    createWorker(queueNames.analyticsEvents, processAnalyticsEvents),
    createWorker(queueNames.mediaProcessing, processMediaProcessing),
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
        queueName: worker.name,
        jobId: job?.id,
        error: error.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    worker.on('error', (error) => {
      logger.error({
        event: 'worker.error',
        queue: worker.name,
        message: error.message,
      });
    });
  }

  return workers;
}

export async function startWorkers(): Promise<boolean> {
  if (!isRedisEnabled() || !redisCommand) {
    if (isRedisRequired()) {
      throw new Error('Workers require Redis, but Redis is not connected');
    }

    logger.warn({
      event: 'workers.skipped',
      reason: 'redis_unavailable',
    });
    return false;
  }

  const activeWorkers = createWorkers();
  logger.info({
    event: 'workers.started',
    queues: activeWorkers.map((worker) => worker.name),
    concurrency: WORKER_CONCURRENCY,
  });
  return true;
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((worker) => worker.close()));
  workers = [];
}
