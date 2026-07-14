import Redis from 'ioredis';
import { logger } from '../../lib/logger';

const url = process.env.PROXIMITY_REDIS_URL || (process.env.NODE_ENV === 'production' ? undefined : process.env.REDIS_URL);
let lastError: string | null = url ? null : 'PROXIMITY_REDIS_URL is not configured';

function create(label: string): Redis | null {
  if (!url) return null;
  const client = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: Number(process.env.PROXIMITY_REDIS_CONNECT_TIMEOUT_MS || 2_000),
    commandTimeout: Number(process.env.PROXIMITY_REDIS_COMMAND_TIMEOUT_MS || 750),
    // BullMQ requires null; commandTimeout and the proximity circuit breaker bound API waits.
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(250 * attempt, 2_000),
    connectionName: `vormex-proximity-${label}`,
  });
  client.on('error', (error) => {
    lastError = error.message;
    logger.warn({ event: 'proximity.redis.error', label, message: error.message });
  });
  client.on('ready', () => { lastError = null; });
  return client;
}

export const proximityRedis = create('command');

export function isProximityRedisReady(): boolean {
  return proximityRedis?.status === 'ready';
}

export function getProximityRedisHealth() {
  return { configured: Boolean(url), ready: isProximityRedisReady(), error: lastError };
}

export async function connectProximityRedis(): Promise<boolean> {
  if (!proximityRedis) return false;
  if (proximityRedis.status === 'ready') return true;
  try {
    await proximityRedis.connect();
    return isProximityRedisReady();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function closeProximityRedis(): Promise<void> {
  if (!proximityRedis) return;
  await proximityRedis.quit().catch(() => proximityRedis.disconnect());
}
