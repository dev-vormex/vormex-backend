
export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheEnvelope<T> {
  __vormexCacheEnvelope: 1;
  value: T;
  softExpiresAt: number;
  hardExpiresAt: number;
}

export interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

export interface CacheRawResult<T> {
  value: T | null;
  backend: 'redis' | 'memory';
}

export interface CacheGetOrSetOptions {
  ttlSeconds?: number;
  tags?: string[];
  swr?: {
    softTtlSeconds: number;
    hardTtlSeconds: number;
  };
  lockTtlMs?: number;
}

export interface FixedWindowIncrementResult {
  backend: 'redis' | 'memory';
  count: number;
  resetAt: number;
}

/**
 * Every key this service writes is namespaced with this prefix. Callers that
 * need to read one of those keys through the raw Redis client — the auth gate
 * pipelines the session key alongside an unprefixed key — must build the key
 * through this constant rather than hardcoding the literal.
 */
export const CACHE_KEY_PREFIX = 'vormex:';

export const CACHE_PREFIX = CACHE_KEY_PREFIX;

export const TAG_PREFIX = `${CACHE_PREFIX}tag:`;

export const LOCK_PREFIX = `${CACHE_PREFIX}lock:`;

export const TTL_JITTER_RATIO = 0.15;

export const DEFAULT_LOCK_TTL_MS = 5_000;

export const DEFAULT_MEMORY_MAX_ENTRIES = 1_000;

const CACHE_METRIC_NAMESPACES = new Set([
  'activity',
  'app-check',
  'auth',
  'feed',
  'matching',
  'mentions',
  'notifications',
  'people',
  'profile',
  'rate',
  'recommendation',
  'reels',
  'safety',
  'stories',
  'talk',
  'test',
]);

export const TAG_INVALIDATION_LUA = `
local keys_to_delete = {}
local seen = {}
local chunk_size = 500

for i = 1, #KEYS do
  local members = redis.call('SMEMBERS', KEYS[i])
  for j = 1, #members do
    local key = members[j]
    if not seen[key] then
      seen[key] = true
      keys_to_delete[#keys_to_delete + 1] = key
    end
  end
end

local deleted = 0

for i = 1, #keys_to_delete, chunk_size do
  local chunk = {}
  local upper = math.min(i + chunk_size - 1, #keys_to_delete)
  for j = i, upper do
    chunk[#chunk + 1] = keys_to_delete[j]
  end
  if #chunk > 0 then
    deleted = deleted + redis.call('DEL', unpack(chunk))
  end
end

for i = 1, #KEYS, chunk_size do
  local chunk = {}
  local upper = math.min(i + chunk_size - 1, #KEYS)
  for j = i, upper do
    chunk[#chunk + 1] = KEYS[j]
  end
  if #chunk > 0 then
    deleted = deleted + redis.call('DEL', unpack(chunk))
  end
end

return deleted
`;

export type RedisStoreRole = 'cache' | 'critical';

export function cacheMetricNamespace(key: string): string {
  const namespace = String(key || '').split(':', 1)[0].trim().toLowerCase();
  return CACHE_METRIC_NAMESPACES.has(namespace) ? namespace : 'other';
}

export interface RedisCacheServiceOptions {
  forceMemory?: boolean;
  maxMemoryEntries?: number;
}
