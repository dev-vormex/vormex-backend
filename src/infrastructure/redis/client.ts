import Redis from 'ioredis';
import { logger } from '../../lib/logger';

export type RedisRole = 'critical' | 'cache';

export interface RedisRoleUrls {
  criticalUrl?: string;
  cacheUrl?: string;
  shared: boolean;
}

/**
 * Resolve role-specific Redis endpoints while preserving REDIS_URL as a
 * backwards-compatible single-instance fallback for local development.
 */
export function resolveRedisRoleUrls(
  env: NodeJS.ProcessEnv = process.env
): RedisRoleUrls {
  const legacyUrl = env.REDIS_URL?.trim() || undefined;
  const criticalUrl = env.CRITICAL_REDIS_URL?.trim() || legacyUrl;
  const cacheUrl = env.CACHE_REDIS_URL?.trim() || legacyUrl || criticalUrl;

  return {
    criticalUrl,
    cacheUrl,
    shared: Boolean(criticalUrl && cacheUrl && criticalUrl === cacheUrl),
  };
}

const { criticalUrl: CRITICAL_REDIS_URL, cacheUrl: CACHE_REDIS_URL } =
  resolveRedisRoleUrls();
const LEGACY_REDIS_REQUIRED = process.env.REDIS_REQUIRED === 'true';
const CRITICAL_REDIS_REQUIRED =
  LEGACY_REDIS_REQUIRED || process.env.CRITICAL_REDIS_REQUIRED === 'true';
const CACHE_REDIS_REQUIRED = process.env.CACHE_REDIS_REQUIRED === 'true';
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
const redisUnavailableReasons = new Map<RedisRole, string>();
const redisClientRoles = new WeakMap<Redis, RedisRole>();

if (!CRITICAL_REDIS_URL) {
  redisUnavailableReasons.set('critical', 'CRITICAL_REDIS_URL/REDIS_URL is not configured');
}
if (!CACHE_REDIS_URL) {
  redisUnavailableReasons.set('cache', 'CACHE_REDIS_URL/REDIS_URL is not configured');
}

if (CRITICAL_REDIS_REQUIRED && !CRITICAL_REDIS_URL) {
  throw new Error('Missing required environment variable: CRITICAL_REDIS_URL (or REDIS_URL)');
}
if (CACHE_REDIS_REQUIRED && !CACHE_REDIS_URL) {
  throw new Error('Missing required environment variable: CACHE_REDIS_URL (or REDIS_URL)');
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRoleRequired(role: RedisRole): boolean {
  return role === 'critical' ? CRITICAL_REDIS_REQUIRED : CACHE_REDIS_REQUIRED;
}

function createRedisClient(
  label: string,
  role: RedisRole,
  url: string | undefined,
  blocking = false
): Redis | null {
  if (!url) {
    return null;
  }

  const client = new Redis(url, {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    ...(blocking ? {} : { commandTimeout: REDIS_COMMAND_TIMEOUT_MS }),
    // API commands fail quickly; the dedicated BullMQ connection must remain null.
    maxRetriesPerRequest: blocking ? null : 1,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy(times) {
      const maxAttempts = isRoleRequired(role)
        ? REDIS_REQUIRED_RETRY_ATTEMPTS
        : REDIS_OPTIONAL_RETRY_ATTEMPTS;
      if (times > maxAttempts) {
        return null;
      }

      return Math.min(250 * 2 ** Math.max(0, times - 1), 5_000);
    },
  });
  redisClientRoles.set(client, role);

  client.on('error', (error) => {
    redisUnavailableReasons.set(role, error.message);

    const now = Date.now();
    const previous = redisErrorLastLoggedAt.get(label) || 0;
    if (now - previous < REDIS_ERROR_LOG_THROTTLE_MS) {
      return;
    }

    redisErrorLastLoggedAt.set(label, now);
    logger[isRoleRequired(role) ? 'error' : 'warn']({
      event: 'redis.error',
      label,
      role,
      message: error.message,
      code: 'code' in error ? String(error.code || '') : undefined,
    });
  });

  client.on('connect', () => {
    logger.info({
      event: 'redis.connect',
      label,
      role,
    });
  });

  client.on('ready', () => {
    redisUnavailableReasons.delete(role);
    logger.info({
      event: 'redis.ready',
      label,
      role,
    });
  });

  client.on('end', () => {
    if (!redisUnavailableReasons.has(role)) {
      redisUnavailableReasons.set(role, 'Redis connection closed');
    }
    logger.warn({
      event: 'redis.end',
      label,
      role,
    });
  });

  return client;
}

// Sessions, BullMQ, realtime fanout, presence, and distributed coordination
// must use the persistent/noeviction critical role.
export const redisCommand = createRedisClient(
  'critical-command',
  'critical',
  CRITICAL_REDIS_URL
);
export const redisPub = createRedisClient('critical-pub', 'critical', CRITICAL_REDIS_URL);
export const redisSub = createRedisClient('critical-sub', 'critical', CRITICAL_REDIS_URL);
// Lazy and worker-only, so API processes do not open an extra blocking connection.
export const redisWorker = createRedisClient(
  'critical-worker',
  'critical',
  CRITICAL_REDIS_URL,
  true
);

// Reuse the command connection when both roles intentionally resolve to the
// same endpoint; production should configure separate role URLs.
export const redisCacheCommand =
  CACHE_REDIS_URL && CACHE_REDIS_URL === CRITICAL_REDIS_URL
    ? redisCommand
    : createRedisClient('cache-command', 'cache', CACHE_REDIS_URL);

export function isRedisEnabled(): boolean {
  return Boolean(
    redisCommand?.status === 'ready' &&
      redisPub?.status === 'ready' &&
      redisSub?.status === 'ready'
  );
}

export const isCriticalRedisEnabled = isRedisEnabled;

export function isCacheRedisEnabled(): boolean {
  return redisCacheCommand?.status === 'ready';
}

export function isRedisConfigured(): boolean {
  return Boolean(redisCommand && redisPub && redisSub);
}

export function isRedisRequired(): boolean {
  return CRITICAL_REDIS_REQUIRED;
}

export const isCriticalRedisRequired = isRedisRequired;

export function isCacheRedisRequired(): boolean {
  return CACHE_REDIS_REQUIRED;
}

async function connectRedisClient(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return;
  }

  await client.connect();
}

function uniqueConfiguredClients(): Redis[] {
  return Array.from(
    new Set(
      [redisCommand, redisPub, redisSub, redisCacheCommand].filter(
        (client): client is Redis => Boolean(client)
      )
    )
  );
}

export async function connectRedisClients(): Promise<void> {
  const clients = uniqueConfiguredClients();

  if (clients.length === 0) {
    if (CRITICAL_REDIS_REQUIRED || CACHE_REDIS_REQUIRED) {
      throw new Error('Redis is required but no Redis clients are configured');
    }
    return;
  }

  const results = await Promise.allSettled(clients.map(connectRedisClient));
  const requiredFailures: string[] = [];

  results.forEach((result, index) => {
    if (result.status !== 'rejected') {
      return;
    }

    const client = clients[index];
    const role = redisClientRoles.get(client) || 'critical';
    const reason = summarizeError(result.reason);
    redisUnavailableReasons.set(role, reason);
    client.disconnect(false);

    const requiredForAnyResolvedRole =
      isRoleRequired(role) ||
      (client === redisCacheCommand && CACHE_REDIS_REQUIRED);
    if (requiredForAnyResolvedRole) {
      requiredFailures.push(`${role}: ${reason}`);
      return;
    }

    logger.warn({
      event: 'redis.role_disabled',
      role,
      message: 'Redis role is unavailable; using the supported local fallback.',
      reason,
    });
  });

  if (requiredFailures.length > 0) {
    throw new Error(`Failed to connect required Redis clients: ${requiredFailures.join('; ')}`);
  }
}

export async function disconnectRedisClients(): Promise<void> {
  await Promise.allSettled(
    Array.from(new Set([...uniqueConfiguredClients(), redisWorker]))
      .filter((client): client is Redis => Boolean(client))
      .map((client) => client.quit().catch(() => client.disconnect()))
  );
}

export interface RedisRoleHealth {
  required: boolean;
  configured: boolean;
  enabled: boolean;
  status: 'disabled' | 'connected' | 'error';
  message?: string;
}

export interface RedisHealth extends RedisRoleHealth {
  roles: {
    critical: RedisRoleHealth;
    cache: RedisRoleHealth;
  };
}

async function getRoleHealth(role: RedisRole): Promise<RedisRoleHealth> {
  const required = isRoleRequired(role);
  const configured = role === 'critical' ? isRedisConfigured() : Boolean(redisCacheCommand);
  const enabled = role === 'critical' ? isRedisEnabled() : isCacheRedisEnabled();
  const command = role === 'critical' ? redisCommand : redisCacheCommand;

  if (!configured) {
    return {
      required,
      configured: false,
      enabled: false,
      status: required ? 'error' : 'disabled',
      ...(required
        ? { message: redisUnavailableReasons.get(role) || `${role} Redis is not configured` }
        : {}),
    };
  }

  if (!enabled || !command) {
    return {
      required,
      configured: true,
      enabled: false,
      status: required ? 'error' : 'disabled',
      message: redisUnavailableReasons.get(role) || `${role} Redis is not connected`,
    };
  }

  try {
    await command.ping();
    return {
      required,
      configured: true,
      enabled: true,
      status: 'connected',
    };
  } catch (error) {
    return {
      required,
      configured: true,
      enabled: true,
      status: 'error',
      message: summarizeError(error),
    };
  }
}

export async function getRedisHealth(): Promise<RedisHealth> {
  const [critical, cache] = await Promise.all([
    getRoleHealth('critical'),
    getRoleHealth('cache'),
  ]);

  return {
    ...critical,
    roles: { critical, cache },
  };
}
