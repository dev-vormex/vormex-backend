import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { isRedisEnabled, redisCommand } from '../redis/client';
import type { QueueName } from './queue-names';

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
  removeOnComplete: 100,
  removeOnFail: 500,
};

const queues = new Map<QueueName, Queue>();

export class QueueUnavailableError extends Error {
  constructor(name: QueueName) {
    super(`Queue "${name}" is unavailable because Redis is not connected`);
    this.name = 'QueueUnavailableError';
  }
}

export function isQueueingEnabled(): boolean {
  return isRedisEnabled() && Boolean(redisCommand);
}

export function getQueue(name: QueueName): Queue {
  if (!isQueueingEnabled() || !redisCommand) {
    throw new QueueUnavailableError(name);
  }

  const existing = queues.get(name);
  if (existing) {
    return existing;
  }

  const queue = new Queue(name, {
    connection: redisCommand,
    defaultJobOptions,
  });

  queues.set(name, queue);
  return queue;
}

export function getAllQueues(): Queue[] {
  return Array.from(queues.values());
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled(getAllQueues().map((queue) => queue.close()));
  queues.clear();
}
