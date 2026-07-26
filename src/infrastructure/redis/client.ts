import Redis from 'ioredis';
import { logger } from '../../lib/logger';

const REDIS_URL = process.env.REDIS_URL;
// Redis-backed features degrade to local/DB fallbacks unless strict mode is explicit.
const REDIS_REQUIRED = process.env.REDIS_REQUIRED === 'true';
const REDIS_CONNECT_TIMEOUT_MS = parsePositiveInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 5_000);
const REDIS_COMMAND_TIMEOUT_MS = parsePositiveInt(process.env.REDIS_COMMAND_TIMEOUT_MS, 1_000);
const REDIS_OPTIONAL_RETRY_ATTEMPTS = parsePositiveInt(
  process.env.REDIS_OPTIONAL_RETRY_ATTEMPTS,
  3
);
const REDIS_REQUIRED_RETRY_ATTEMPTS = parsePositiveInt(
  process.env.REDIS_REQUIRED_RETRY_ATTEMPTS,
  5
);
const REDIS_ERROR_LOG_THROTTLE_MS = parsePositiveInt(
  process.env.REDIS_ERROR_LOG_THROTTLE_MS,
  30_000
);

const redisErrorLastLoggedAt = new Map<string, number>();
let redisUnavailableReason: string | undefined = REDIS_URL
  ? undefined
  : 'REDIS_URL is not configured';

if (REDIS_REQUIRED && !REDIS_URL) {
  throw new Error('Missing required environment variable: REDIS_URL');
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRedisClient(label: string, blocking = false): Redis | null {
  if (!REDIS_URL) {
    return null;
  }

  const client = new Redis(REDIS_URL, {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    ...(blocking ? {} : { commandTimeout: REDIS_COMMAND_TIMEOUT_MS }),
    // API commands fail quickly; the dedicated BullMQ connection must remain null.
    maxRetriesPerRequest: blocking ? null : 1,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy(times) {
      const maxAttempts = REDIS_REQUIRED
        ? REDIS_REQUIRED_RETRY_ATTEMPTS
        : REDIS_OPTIONAL_RETRY_ATTEMPTS;
      if (times > maxAttempts) {
        return null;
      }

      return Math.min(250 * 2 ** Math.max(0, times - 1), 5_000);
    },
  });

  client.on('error', (error) => {
    redisUnavailableReason = error.message;

    const now = Date.now();
    const previous = redisErrorLastLoggedAt.get(label) || 0;
    if (now - previous < REDIS_ERROR_LOG_THROTTLE_MS) {
      return;
    }

    redisErrorLastLoggedAt.set(label, now);
    logger[REDIS_REQUIRED ? 'error' : 'warn']({
      event: 'redis.error',
      label,
      message: error.message,
      code: 'code' in error ? String(error.code || '') : undefined,
    });
  });

  client.on('connect', () => {
    logger.info({
      event: 'redis.connect',
      label,
    });
  });

  client.on('ready', () => {
    if (isRedisEnabled()) {
      redisUnavailableReason = undefined;
    }
    logger.info({
      event: 'redis.ready',
      label,
    });
  });

  client.on('end', () => {
    if (!redisUnavailableReason) {
      redisUnavailableReason = 'Redis connection closed';
    }
    logger.warn({
      event: 'redis.end',
      label,
    });
  });

  return client;
}

export const redisCommand = createRedisClient('command');
export const redisPub = createRedisClient('pub');
export const redisSub = createRedisClient('sub');
// Lazy and worker-only, so API processes do not open an extra Redis connection.
export const redisWorker = createRedisClient('worker', true);

export function isRedisEnabled(): boolean {
  return Boolean(
    redisCommand?.status === 'ready' &&
      redisPub?.status === 'ready' &&
      redisSub?.status === 'ready'
  );
}

export function isRedisConfigured(): boolean {
  return Boolean(redisCommand && redisPub && redisSub);
}

export function isRedisRequired(): boolean {
  return REDIS_REQUIRED;
}

async function connectRedisClient(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return;
  }

  await client.connect();
}

export async function connectRedisClients(): Promise<void> {
  const clients = [redisCommand, redisPub, redisSub].filter(
    (client): client is Redis => Boolean(client)
  );

  if (clients.length === 0) {
    if (REDIS_REQUIRED) {
      throw new Error('Redis is required but no Redis clients are configured');
    }
    return;
  }

  const results = await Promise.allSettled(clients.map(connectRedisClient));
  const failures = results.filter((result) => result.status === 'rejected');

  if (failures.length > 0) {
    const firstFailure = failures[0] as PromiseRejectedResult;
    redisUnavailableReason = summarizeError(firstFailure.reason);

    if (REDIS_REQUIRED) {
      throw new Error(`Failed to connect required Redis clients: ${redisUnavailableReason}`);
    }

    logger.warn({
      event: 'redis.disabled',
      message: 'Redis is unavailable; using in-memory fallbacks for this process.',
      reason: redisUnavailableReason,
    });

    for (const client of clients) {
      client.disconnect(false);
    }
  }
}

export async function disconnectRedisClients(): Promise<void> {
  await Promise.allSettled(
    [redisCommand, redisPub, redisSub, redisWorker]
      .filter((client): client is Redis => Boolean(client))
      .map((client) => client.quit().catch(() => client.disconnect()))
  );
}

export async function getRedisHealth(): Promise<{
  required: boolean;
  enabled: boolean;
  status: 'disabled' | 'connected' | 'error';
  message?: string;
}> {
  if (!isRedisConfigured()) {
    return {
      required: REDIS_REQUIRED,
      enabled: false,
      status: REDIS_REQUIRED ? 'error' : 'disabled',
      ...(REDIS_REQUIRED ? { message: 'REDIS_URL is not configured' } : {}),
    };
  }

  if (!isRedisEnabled() || !redisCommand) {
    return {
      required: REDIS_REQUIRED,
      enabled: false,
      status: REDIS_REQUIRED ? 'error' : 'disabled',
      message: redisUnavailableReason || 'Redis is not connected',
    };
  }

  try {
    await redisCommand.ping();
    return {
      required: REDIS_REQUIRED,
      enabled: true,
      status: 'connected',
    };
  } catch (error) {
    return {
      required: REDIS_REQUIRED,
      enabled: true,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
