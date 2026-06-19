import { isRedisRequired, redisCommand } from '../infrastructure/redis/client';
import type { AuthenticatedRequest } from '../types/auth.types';

export interface RateLimitRule {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
  code?: string;
  emergencyLimit?: number;
  emergencyWindowSeconds?: number;
  message?: string;
  identifier?: (req: AuthenticatedRequest) => string | null | undefined;
}

export interface RateLimitResult {
  allowed: boolean;
  backend: 'emergency_memory' | 'memory' | 'redis';
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

const SLIDING_WINDOW_INCREMENT_LUA = `
local current = redis.call('INCR', KEYS[1])
local current_ttl = redis.call('PTTL', KEYS[1])
if current_ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end

local previous = tonumber(redis.call('GET', KEYS[2]) or '0')

return { current, previous }
`;

class RateLimitUnavailableError extends Error {
  statusCode = 503;
  status = 'rate_limiter_unavailable';

  constructor() {
    super('Rate limiter is unavailable');
    this.name = 'RateLimitUnavailableError';
  }
}

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();
const emergencyMemoryBuckets = new Map<string, { count: number; resetAt: number }>();

function getRedisClient() {
  if (!redisCommand || redisCommand.status !== 'ready') {
    throw new RateLimitUnavailableError();
  }

  return redisCommand;
}

function normalizeRouteName(keyPrefix: string): string {
  const trimmed = String(keyPrefix || '').trim().replace(/^:+|:+$/g, '');
  return trimmed.startsWith('rate:') ? trimmed.slice('rate:'.length) : trimmed;
}

function buildRateLimitKey(routeName: string, identifier: string, windowIndex: number): string {
  return `rate:${routeName}:${identifier}:${windowIndex}`;
}

function evaluateMemoryRateLimit(
  identifier: string,
  rule: RateLimitRule,
  backend: RateLimitResult['backend'] = 'memory',
  buckets: Map<string, { count: number; resetAt: number }> = memoryBuckets
): RateLimitResult {
  const routeName = normalizeRouteName(rule.keyPrefix);
  const windowMs = Math.max(1, Math.floor(rule.windowSeconds * 1000));
  const nowMs = Date.now();
  const windowIndex = Math.floor(nowMs / windowMs);
  const windowStartMs = windowIndex * windowMs;
  const resetAt = windowStartMs + windowMs;
  const key = buildRateLimitKey(routeName, identifier, windowIndex);
  const bucket = buckets.get(key);
  const count = bucket && bucket.resetAt > nowMs ? bucket.count + 1 : 1;

  buckets.set(key, { count, resetAt });

  if (buckets.size > 10_000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= nowMs) {
        buckets.delete(bucketKey);
      }
    }
  }

  return {
    allowed: count <= rule.limit,
    backend,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)),
  };
}

export function evaluateEmergencyRateLimit(identifier: string, rule: RateLimitRule): RateLimitResult {
  const emergencyRule: RateLimitRule = {
    ...rule,
    keyPrefix: `${rule.keyPrefix}:emergency`,
    limit: Math.max(1, Math.min(rule.limit, rule.emergencyLimit || 5)),
    windowSeconds: Math.max(1, Math.min(rule.windowSeconds, rule.emergencyWindowSeconds || 60)),
  };

  return evaluateMemoryRateLimit(identifier, emergencyRule, 'emergency_memory', emergencyMemoryBuckets);
}

function parseRedisNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value) || 0;
  }
  if (Buffer.isBuffer(value)) {
    return Number(value.toString()) || 0;
  }
  return 0;
}

function parseEvalCounts(value: unknown): { currentCount: number; previousCount: number } {
  const result = Array.isArray(value) ? value : [];
  return {
    currentCount: parseRedisNumber(result[0]),
    previousCount: parseRedisNumber(result[1]),
  };
}

function calculateRetryAfterMs(params: {
  currentCount: number;
  estimatedCount: number;
  limit: number;
  nowMs: number;
  previousCount: number;
  windowMs: number;
  windowStartMs: number;
}): number {
  const { currentCount, estimatedCount, limit, nowMs, previousCount, windowMs, windowStartMs } = params;
  if (estimatedCount <= limit) {
    return Math.max(1, windowStartMs + windowMs - nowMs);
  }

  const elapsedMs = Math.max(0, nowMs - windowStartMs);
  const capacityForPreviousWindow = limit - currentCount;

  if (capacityForPreviousWindow >= 0 && previousCount > 0) {
    const requiredElapsedMs = windowMs * (1 - capacityForPreviousWindow / previousCount);
    return Math.max(1, Math.ceil(requiredElapsedMs - elapsedMs));
  }

  if (currentCount > limit) {
    const nextWindowStartMs = windowStartMs + windowMs;
    const decayElapsedMs = windowMs * (1 - limit / currentCount);
    return Math.max(1, Math.ceil(nextWindowStartMs + decayElapsedMs - nowMs));
  }

  return Math.max(1, windowStartMs + windowMs - nowMs);
}

export async function evaluateRateLimit(
  identifier: string,
  rule: RateLimitRule
): Promise<RateLimitResult> {
  let client: NonNullable<typeof redisCommand>;
  try {
    client = getRedisClient();
  } catch (error) {
    if (!isRedisRequired()) {
      return evaluateMemoryRateLimit(identifier, rule);
    }
    throw error;
  }

  const routeName = normalizeRouteName(rule.keyPrefix);
  const windowMs = Math.max(1, Math.floor(rule.windowSeconds * 1000));
  const nowMs = Date.now();
  const windowIndex = Math.floor(nowMs / windowMs);
  const windowStartMs = windowIndex * windowMs;
  const elapsedMs = Math.max(0, nowMs - windowStartMs);
  const previousWindowWeight = Math.max(0, (windowMs - elapsedMs) / windowMs);
  const currentKey = buildRateLimitKey(routeName, identifier, windowIndex);
  const previousKey = buildRateLimitKey(routeName, identifier, windowIndex - 1);
  const ttlMs = windowMs * 2 + 1_000;

  let currentCount: number;
  let previousCount: number;
  try {
    ({ currentCount, previousCount } = parseEvalCounts(
      await client.eval(
        SLIDING_WINDOW_INCREMENT_LUA,
        2,
        currentKey,
        previousKey,
        String(ttlMs)
      )
    ));
  } catch (error) {
    if (!isRedisRequired()) {
      return evaluateMemoryRateLimit(identifier, rule);
    }
    throw error;
  }
  const estimatedCount = currentCount + previousCount * previousWindowWeight;
  const allowed = estimatedCount <= rule.limit;
  const retryAfterMs = calculateRetryAfterMs({
    currentCount,
    estimatedCount,
    limit: rule.limit,
    nowMs,
    previousCount,
    windowMs,
    windowStartMs,
  });

  return {
    allowed,
    backend: 'redis',
    limit: rule.limit,
    remaining: Math.max(0, Math.floor(rule.limit - estimatedCount)),
    resetAt: nowMs + retryAfterMs,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}
