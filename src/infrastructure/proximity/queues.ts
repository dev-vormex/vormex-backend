import { Queue } from 'bullmq';
import { proximityRedis, isProximityRedisReady } from './redis-client';

export const proximityQueueNames = {
  accumulation: 'proximity_accumulation', persistence: 'proximity_persistence',
  maintenance: 'proximity_maintenance', summary: 'proximity_summary', deadLetter: 'proximity_dead_letter',
} as const;

const queues = new Map<string, Queue>();
export function getProximityQueue(name: string): Queue {
  if (!proximityRedis || !isProximityRedisReady()) throw new Error('PROXIMITY_REDIS_UNAVAILABLE');
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, { connection: proximityRedis, defaultJobOptions: {
    attempts: 3, backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 }, removeOnComplete: 500, removeOnFail: 1_000,
  }});
  queues.set(name, queue);
  return queue;
}

export async function closeProximityQueues(): Promise<void> {
  await Promise.allSettled(Array.from(queues.values()).map((queue) => queue.close()));
  queues.clear();
}
