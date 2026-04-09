import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { redisCommand } from '../redis/client';
import { queueNames, type QueueName } from './queue-names';

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

export function getQueue(name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) {
    return existing;
  }

  const queue = new Queue(name, {
    connection: redisCommand || undefined,
    defaultJobOptions,
  });

  queues.set(name, queue);
  return queue;
}

export function getAllQueues(): Queue[] {
  return (Object.values(queueNames) as QueueName[]).map((name) => getQueue(name));
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled(getAllQueues().map((queue) => queue.close()));
}
