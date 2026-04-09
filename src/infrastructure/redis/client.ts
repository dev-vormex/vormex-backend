import Redis from 'ioredis';
import { logger } from '../../lib/logger';

const REDIS_URL = process.env.REDIS_URL;

function createRedisClient(label: string): Redis | null {
  if (!REDIS_URL) {
    return null;
  }

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  client.on('error', (error) => {
    logger.error({
      event: 'redis.error',
      label,
      message: error.message,
    });
  });

  client.on('connect', () => {
    logger.info({
      event: 'redis.connect',
      label,
    });
  });

  return client;
}

export const redisCommand = createRedisClient('command');
export const redisPub = createRedisClient('pub');
export const redisSub = createRedisClient('sub');

export function isRedisEnabled(): boolean {
  return Boolean(redisCommand && redisPub && redisSub);
}

export async function connectRedisClients(): Promise<void> {
  await Promise.allSettled(
    [redisCommand, redisPub, redisSub]
      .filter((client): client is Redis => Boolean(client))
      .map((client) => client.connect().catch(() => undefined))
  );
}

export async function disconnectRedisClients(): Promise<void> {
  await Promise.allSettled(
    [redisCommand, redisPub, redisSub]
      .filter((client): client is Redis => Boolean(client))
      .map((client) => client.quit().catch(() => client.disconnect()))
  );
}
