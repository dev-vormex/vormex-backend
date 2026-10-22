import type Redis from 'ioredis';
import { isRedisRequired, redisCommand } from '../redis/client';
import type { AuthenticatedRequest } from '../../modules/auth/types/auth.types';

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

/**
 * Increments every rule's sliding window in one script call.
 *
 * A single authenticated read of the feed resolves to seven rules. Evaluating
 * them one await at a time meant seven serial Redis latencies before routing;
 * this collapses them into one. KEYS arrive in (current, previous) pairs and
 * ARGV[i] carries the TTL for pair i, so the reply is a flat array of 2N counts.
 *
 * Consequence worth knowing: because all commands are sent before any reply is
 * seen, a request that trips rule 1 is still counted by rules 2..N. That is
 * stricter than the old short-circuit, which is the correct direction for abuse
 * protection — a rejected request did still consume server work.
 */
const SLIDING_WINDOW_BATCH_LUA = `
local results = {}
local rule_count = #KEYS / 2

for index = 1, rule_count do
  local current_key = KEYS[index * 2 - 1]
  local previous_key = KEYS[index * 2]

  local current = redis.call('INCR', current_key)
  local current_ttl = redis.call('PTTL', current_key)
  if current_ttl < 0 then
    redis.call('PEXPIRE', current_key, ARGV[index])
  end

  local previous = tonumber(redis.call('GET', previous_key) or '0')

  results[#results + 1] = current
  results[#results + 1] = previous
end

return results
`;

const SLIDING_WINDOW_COMMAND = 'vormexSlidingWindowBatch';

type RedisWithSlidingWindow = Redis & {
  [SLIDING_WINDOW_COMMAND]: (...args: Array<string | number>) => Promise<unknown>;
};

// ioredis caches the script SHA behind a defined command and retries EVALSHA
// through EVAL on NOSCRIPT, so the Lua body stops travelling on every call.
const clientsWithCommandDefined = new WeakSet<Redis>();

function withSlidingWindowCommand(client: Redis): RedisWithSlidingWindow {
  if (!clientsWithCommandDefined.has(client)) {
    client.defineCommand(SLIDING_WINDOW_COMMAND, { lua: SLIDING_WINDOW_BATCH_LUA });
    clientsWithCommandDefined.add(client);
  }
  return client as RedisWithSlidingWindow;
}

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

function parseBatchCounts(
  value: unknown,
  ruleCount: number
): Array<{ currentCount: number; previousCount: number }> | null {
  if (!Array.isArray(value) || value.length < ruleCount * 2) {
    return null;
  }

  const counts: Array<{ currentCount: number; previousCount: number }> = [];
  for (let index = 0; index < ruleCount; index += 1) {
    counts.push({
      currentCount: parseRedisNumber(value[index * 2]),
      previousCount: parseRedisNumber(value[index * 2 + 1]),
    });
  }
  return counts;
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

export interface RateLimitEvaluation {
  identifier: string;
  rule: RateLimitRule;
}

interface RuleWindow {
  currentKey: string;
  previousKey: string;
  ttlMs: number;
  windowMs: number;
  windowStartMs: number;
  previousWindowWeight: number;
}

function buildRuleWindow(identifier: string, rule: RateLimitRule, nowMs: number): RuleWindow {
  const routeName = normalizeRouteName(rule.keyPrefix);
  const windowMs = Math.max(1, Math.floor(rule.windowSeconds * 1000));
  const windowIndex = Math.floor(nowMs / windowMs);
  const windowStartMs = windowIndex * windowMs;
  const elapsedMs = Math.max(0, nowMs - windowStartMs);

  return {
    currentKey: buildRateLimitKey(routeName, identifier, windowIndex),
    previousKey: buildRateLimitKey(routeName, identifier, windowIndex - 1),
    ttlMs: windowMs * 2 + 1_000,
    windowMs,
    windowStartMs,
    previousWindowWeight: Math.max(0, (windowMs - elapsedMs) / windowMs),
  };
}

function resolveRuleResult(params: {
  rule: RateLimitRule;
  window: RuleWindow;
  counts: { currentCount: number; previousCount: number };
  nowMs: number;
}): RateLimitResult {
  const { rule, window, counts, nowMs } = params;
  const { currentCount, previousCount } = counts;
  const estimatedCount = currentCount + previousCount * window.previousWindowWeight;
  const retryAfterMs = calculateRetryAfterMs({
    currentCount,
    estimatedCount,
    limit: rule.limit,
    nowMs,
    previousCount,
    windowMs: window.windowMs,
    windowStartMs: window.windowStartMs,
  });

  return {
    allowed: estimatedCount <= rule.limit,
    backend: 'redis',
    limit: rule.limit,
    remaining: Math.max(0, Math.floor(rule.limit - estimatedCount)),
    resetAt: nowMs + retryAfterMs,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

/**
 * Evaluates every rule for a request in a single Redis round trip.
 *
 * Results are returned positionally, so the caller can keep applying rules in
 * priority order. Throws only when Redis is required; otherwise it degrades to
 * the in-memory limiter exactly as the single-rule path always has.
 */
export async function evaluateRateLimits(
  evaluations: RateLimitEvaluation[]
): Promise<RateLimitResult[]> {
  if (evaluations.length === 0) {
    return [];
  }

  const degradeToMemory = (): RateLimitResult[] =>
    evaluations.map(({ identifier, rule }) => evaluateMemoryRateLimit(identifier, rule));

  let client: NonNullable<typeof redisCommand>;
  try {
    client = getRedisClient();
  } catch (error) {
    if (!isRedisRequired()) {
      return degradeToMemory();
    }
    throw error;
  }

  const nowMs = Date.now();
  const windows = evaluations.map(({ identifier, rule }) =>
    buildRuleWindow(identifier, rule, nowMs)
  );

  const keys: string[] = [];
  const ttls: string[] = [];
  for (const window of windows) {
    keys.push(window.currentKey, window.previousKey);
    ttls.push(String(window.ttlMs));
  }

  let reply: unknown;
  try {
    reply = await withSlidingWindowCommand(client)[SLIDING_WINDOW_COMMAND](
      String(keys.length),
      ...keys,
      ...ttls
    );
  } catch (error) {
    if (!isRedisRequired()) {
      return degradeToMemory();
    }
    throw error;
  }

  const counts = parseBatchCounts(reply, evaluations.length);
  if (!counts) {
    // A malformed reply must not silently read as "allowed".
    if (!isRedisRequired()) {
      return degradeToMemory();
    }
    throw new RateLimitUnavailableError();
  }

  return evaluations.map(({ rule }, index) =>
    resolveRuleResult({ rule, window: windows[index], counts: counts[index], nowMs })
  );
}

export async function evaluateRateLimit(
  identifier: string,
  rule: RateLimitRule
): Promise<RateLimitResult> {
  const [result] = await evaluateRateLimits([{ identifier, rule }]);
  return result;
}
