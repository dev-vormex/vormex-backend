import Redis from 'ioredis';
import { logger } from '../../lib/logger';

const url = process.env.PROXIMITY_REDIS_URL || (process.env.NODE_ENV === 'production' ? undefined : process.env.REDIS_URL);
let lastError: string | null = url ? null : 'PROXIMITY_REDIS_URL is not configured';
let lastErrorLoggedAt = 0;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function create(label: string): Redis | null {
  if (!url) return null;
  const client = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: positiveInt(process.env.PROXIMITY_REDIS_CONNECT_TIMEOUT_MS, 2_000),
    commandTimeout: positiveInt(process.env.PROXIMITY_REDIS_COMMAND_TIMEOUT_MS, 750),
    // BullMQ requires null; commandTimeout and the proximity circuit breaker bound API waits.
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => {
      const maxAttempts = positiveInt(process.env.PROXIMITY_REDIS_RETRY_ATTEMPTS, 3);
      if (attempt > maxAttempts) return null;
      return Math.min(250 * 2 ** Math.max(0, attempt - 1), 2_000);
    },
    connectionName: `vormex-proximity-${label}`,
  });
  client.on('error', (error) => {
    lastError = error.message;
    const now = Date.now();
    if (now - lastErrorLoggedAt < 30_000) return;
    lastErrorLoggedAt = now;
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
