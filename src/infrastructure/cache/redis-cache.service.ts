import {
  isCacheRedisEnabled,
  isCacheRedisRequired,
  isCriticalRedisEnabled,
  isCriticalRedisRequired,
  redisCacheCommand,
  redisCommand,
} from '../redis/client';
import {
  cacheOperationDuration,
  cacheOutcomeCounter,
  cacheRequestCounter,
} from '../metrics/registry';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface CacheEnvelope<T> {
  __vormexCacheEnvelope: 1;
  value: T;
  softExpiresAt: number;
  hardExpiresAt: number;
}

interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

interface CacheRawResult<T> {
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

const CACHE_PREFIX = 'vormex:';
const TAG_PREFIX = `${CACHE_PREFIX}tag:`;
const LOCK_PREFIX = `${CACHE_PREFIX}lock:`;
const TTL_JITTER_RATIO = 0.15;
const DEFAULT_LOCK_TTL_MS = 5_000;
const DEFAULT_MEMORY_MAX_ENTRIES = 1_000;
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
const TAG_INVALIDATION_LUA = `
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

type RedisStoreRole = 'cache' | 'critical';

export function cacheMetricNamespace(key: string): string {
  const namespace = String(key || '').split(':', 1)[0].trim().toLowerCase();
  return CACHE_METRIC_NAMESPACES.has(namespace) ? namespace : 'other';
}

interface RedisCacheServiceOptions {
  forceMemory?: boolean;
  maxMemoryEntries?: number;
}

export class RedisCacheService {
  private cache = new Map<string, CacheEntry<unknown>>();
  private fixedWindows = new Map<string, FixedWindowEntry>();
  private tagIndex = new Map<string, Set<string>>();
  private keyTags = new Map<string, Set<string>>();
  private inFlight = new Map<string, Promise<unknown>>();
  private readonly forceMemory: boolean;
  private readonly maxMemoryEntries: number;

  constructor(
    private readonly role: RedisStoreRole = 'cache',
    options: RedisCacheServiceOptions = {}
  ) {
    this.forceMemory = options.forceMemory === true;
    const configuredMax = Number.parseInt(
      process.env.CACHE_MEMORY_MAX_ENTRIES || '',
      10
    );
    this.maxMemoryEntries = Math.max(
      1,
      options.maxMemoryEntries ||
        (Number.isFinite(configuredMax) && configuredMax > 0
          ? configuredMax
          : DEFAULT_MEMORY_MAX_ENTRIES)
    );
  }

  private key(key: string): string {
    return `${CACHE_PREFIX}${key}`;
  }

  private tagKey(tag: string): string {
    return `${TAG_PREFIX}${tag}`;
  }

  private getRedisClient() {
    if (this.forceMemory) {
      return null;
    }
    if (this.role === 'critical') {
      return isCriticalRedisEnabled() ? redisCommand : null;
    }
    return isCacheRedisEnabled() ? redisCacheCommand : null;
  }

  private handleRedisError(error: unknown): void {
    const required = this.role === 'critical'
      ? isCriticalRedisRequired()
      : isCacheRedisRequired();
    if (required) {
      throw error;
    }
  }

  private record(
    operation: string,
    outcome: string,
    key: string,
    backend: 'redis' | 'memory',
    startedAt: number
  ): void {
    cacheOutcomeCounter.inc({ operation, outcome });
    const labels = {
      operation,
      outcome,
      backend,
      namespace: cacheMetricNamespace(key),
    };
    cacheRequestCounter.inc(labels);
    cacheOperationDuration.observe(labels, Math.max(0, Date.now() - startedAt));
  }

  private jitterTtlSeconds(ttlSeconds: number): number {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 1) {
      return Math.max(1, Math.floor(ttlSeconds));
    }
    const spread = ttlSeconds * TTL_JITTER_RATIO;
    const min = Math.max(1, Math.floor(ttlSeconds - spread));
    const max = Math.max(min, Math.ceil(ttlSeconds + spread));
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  private isEnvelope<T>(value: unknown): value is CacheEnvelope<T> {
    return Boolean(
      value &&
        typeof value === 'object' &&
        (value as { __vormexCacheEnvelope?: unknown }).__vormexCacheEnvelope === 1
    );
  }

  private cacheState<T>(value: unknown): { state: 'hit' | 'stale'; value: T } {
    if (!this.isEnvelope<T>(value)) {
      return { state: 'hit', value: value as T };
    }
    return {
      state: Date.now() <= value.softExpiresAt ? 'hit' : 'stale',
      value: value.value,
    };
  }

  private removeMemoryKey(key: string): void {
    this.cache.delete(key);
    const tags = this.keyTags.get(key);
    if (!tags) {
      return;
    }

    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) {
        this.tagIndex.delete(tag);
      }
    }
    this.keyTags.delete(key);
  }

  private readMemory<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.removeMemoryKey(key);
      return null;
    }

    // Map insertion order doubles as a small LRU for degraded-mode reads.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value as T;
  }

  private writeMemory<T>(
    key: string,
    value: T,
    expiresAt: number,
    tags: string[]
  ): void {
    this.removeMemoryKey(key);
    this.cache.set(key, { value, expiresAt });

    const uniqueTags = new Set(tags.filter(Boolean));
    if (uniqueTags.size > 0) {
      this.keyTags.set(key, uniqueTags);
      for (const tag of uniqueTags) {
        const keys = this.tagIndex.get(tag) || new Set<string>();
        keys.add(key);
        this.tagIndex.set(tag, keys);
      }
    }

    while (this.cache.size > this.maxMemoryEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.removeMemoryKey(oldestKey);
    }
  }

  private async getRaw<T>(key: string): Promise<CacheRawResult<T>> {
    const client = this.getRedisClient();
    if (client) {
      try {
        const raw = await client.get(this.key(key));
        return {
          value: raw ? (JSON.parse(raw) as T) : null,
          backend: 'redis',
        };
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    return {
      value: this.readMemory<T>(key),
      backend: 'memory',
    };
  }

  async get<T>(key: string): Promise<T | null> {
    const startedAt = Date.now();
    const raw = await this.getRaw<T | CacheEnvelope<T>>(key);
    if (raw.value === null) {
      this.record('get', 'miss', key, raw.backend, startedAt);
      return null;
    }

    const state = this.cacheState<T>(raw.value);
    this.record('get', state.state, key, raw.backend, startedAt);
    return state.value;
  }

  async set<T>(key: string, value: T, ttlSeconds = 300, tags: string[] = []): Promise<void> {
    return this.setRaw(key, value, ttlSeconds, tags);
  }

  private async setRaw<T>(key: string, value: T, ttlSeconds = 300, tags: string[] = []): Promise<void> {
    const startedAt = Date.now();
    const effectiveTtlSeconds = this.jitterTtlSeconds(ttlSeconds);
    const client = this.getRedisClient();
    let backend: 'redis' | 'memory' = 'memory';
    if (client) {
      try {
        const redisKey = this.key(key);
        await client.set(redisKey, JSON.stringify(value), 'EX', effectiveTtlSeconds);
        if (tags.length > 0) {
          const pipeline = client.multi();
          for (const tag of tags) {
            pipeline.sadd(this.tagKey(tag), redisKey);
            // Initialize a tag TTL once, then only extend it. A short-lived
            // member must never orphan longer-lived members from invalidation.
            pipeline.expire(this.tagKey(tag), effectiveTtlSeconds, 'NX');
            pipeline.expire(this.tagKey(tag), effectiveTtlSeconds, 'GT');
          }
          await pipeline.exec();
        }
        backend = 'redis';
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    this.writeMemory(
      key,
      value,
      Date.now() + effectiveTtlSeconds * 1000,
      tags
    );
    this.record('set', 'stored', key, backend, startedAt);
  }

  async getOrSet<T>(
    key: string,
    compute: () => Promise<T>,
    options: CacheGetOrSetOptions = {}
  ): Promise<T> {
    const startedAt = Date.now();
    const raw = await this.getRaw<T | CacheEnvelope<T>>(key);
    if (raw.value !== null) {
      const state = this.cacheState<T>(raw.value);
      if (state.state === 'hit') {
        this.record('get_or_set', 'hit', key, raw.backend, startedAt);
        return state.value;
      }

      if (options.swr) {
        this.record('get_or_set', 'stale', key, raw.backend, startedAt);
        void this.runSingleFlight(key, compute, options).catch(() => undefined);
        return state.value;
      }
    }

    this.record('get_or_set', 'miss', key, raw.backend, startedAt);
    return this.runSingleFlight(key, compute, options);
  }

  private async runSingleFlight<T>(
    key: string,
    compute: () => Promise<T>,
    options: CacheGetOrSetOptions
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.record('get_or_set', 'single-flight-wait', key, 'memory', Date.now());
      return existing as Promise<T>;
    }

    const promise = this.computeAndStore(key, compute, options);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async computeAndStore<T>(
    key: string,
    compute: () => Promise<T>,
    options: CacheGetOrSetOptions
  ): Promise<T> {
    const lockToken = `${process.pid}:${Date.now()}:${Math.random()}`;
    const lockKey = `${LOCK_PREFIX}${key}`;
    const lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    let acquiredRedisLock = false;
    const client = this.getRedisClient();

    if (client) {
      try {
        acquiredRedisLock = (await client.set(lockKey, lockToken, 'PX', lockTtlMs, 'NX')) === 'OK';
        if (!acquiredRedisLock) {
          this.record('get_or_set', 'single-flight-wait', key, 'redis', Date.now());
          const deadline = Date.now() + lockTtlMs;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            const raw = await this.getRaw<T | CacheEnvelope<T>>(key);
            if (raw.value !== null) {
              return this.cacheState<T>(raw.value).value;
            }
          }
        }
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    try {
      const value = await compute();
      if (options.swr) {
        const now = Date.now();
        const envelope: CacheEnvelope<T> = {
          __vormexCacheEnvelope: 1,
          value,
          softExpiresAt: now + options.swr.softTtlSeconds * 1000,
          hardExpiresAt: now + options.swr.hardTtlSeconds * 1000,
        };
        await this.setRaw(key, envelope, options.swr.hardTtlSeconds, options.tags || []);
      } else {
        await this.setRaw(key, value, options.ttlSeconds ?? 300, options.tags || []);
      }
      return value;
    } finally {
      if (client && acquiredRedisLock) {
        try {
          if ((await client.get(lockKey)) === lockToken) {
            await client.del(lockKey);
          }
        } catch (error) {
          this.handleRedisError(error);
        }
      }
    }
  }

  async del(key: string): Promise<void> {
    const client = this.getRedisClient();
    if (client) {
      try {
        await client.del(this.key(key));
      } catch (error) {
        this.handleRedisError(error);
      }
    }
    this.removeMemoryKey(key);
  }

  async delPattern(pattern: string): Promise<void> {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);

    const client = this.getRedisClient();
    if (client) {
      try {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await client.scan(
            cursor,
            'MATCH',
            this.key(pattern),
            'COUNT',
            100
          );
          cursor = nextCursor;
          if (keys.length > 0) {
            await client.del(...keys);
          }
        } while (cursor !== '0');
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    for (const key of Array.from(this.cache.keys())) {
      if (regex.test(key)) {
        this.removeMemoryKey(key);
      }
    }
  }

  async invalidateTags(...tags: string[]): Promise<void> {
    const uniqueTags = Array.from(new Set(tags.filter(Boolean)));
    if (uniqueTags.length === 0) {
      return;
    }

    const client = this.getRedisClient();
    if (client) {
      try {
        await client.eval(
          TAG_INVALIDATION_LUA,
          uniqueTags.length,
          ...uniqueTags.map((tag) => this.tagKey(tag))
        );
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    for (const tag of uniqueTags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      for (const key of Array.from(keys)) {
        this.removeMemoryKey(key);
      }
      this.tagIndex.delete(tag);
    }
  }

  async exists(key: string): Promise<boolean> {
    const client = this.getRedisClient();
    if (client) {
      try {
        return (await client.exists(this.key(key))) === 1;
      } catch (error) {
        this.handleRedisError(error);
      }
    }
    return this.readMemory(key) !== null;
  }

  async incrementFixedWindow(key: string, windowSeconds: number): Promise<FixedWindowIncrementResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowIndex = Math.floor(now / windowMs);
    const resetAt = (windowIndex + 1) * windowMs;
    const fixedWindowKey = `${key}:${windowIndex}`;

    const client = this.getRedisClient();
    if (client) {
      try {
        const redisKey = this.key(fixedWindowKey);
        const pipeline = client.multi();
        pipeline.incr(redisKey);
        pipeline.pttl(redisKey);
        const results = await pipeline.exec();
        const count = Number(results?.[0]?.[1] || 0);
        let ttlMs = Number(results?.[1]?.[1] || 0);
        if (ttlMs <= 0) {
          ttlMs = Math.max(1_000, resetAt - now);
          await client.pexpire(redisKey, ttlMs);
        }
        return {
          backend: 'redis',
          count,
          resetAt: now + ttlMs,
        };
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    for (const [memoryKey, entry] of Array.from(this.fixedWindows.entries())) {
      if (entry.resetAt <= now) {
        this.fixedWindows.delete(memoryKey);
      }
    }

    const existing = this.fixedWindows.get(fixedWindowKey);
    const next = existing
      ? { count: existing.count + 1, resetAt: existing.resetAt }
      : { count: 1, resetAt };

    this.fixedWindows.set(fixedWindowKey, next);
    return {
      backend: 'memory',
      count: next.count,
      resetAt: next.resetAt,
    };
  }

  getStats() {
    return {
      backend: this.getRedisClient() ? 'redis' : 'memory',
      role: this.role,
      keys: this.cache.size,
      tagKeys: this.tagIndex.size,
      rateWindows: this.fixedWindows.size,
      inFlight: this.inFlight.size,
      maxMemoryEntries: this.maxMemoryEntries,
    };
  }

  __testJitterTtlSeconds(ttlSeconds: number): number {
    return this.jitterTtlSeconds(ttlSeconds);
  }
}

export const redisCacheService = new RedisCacheService();
export const redisSessionStore = new RedisCacheService('critical');
