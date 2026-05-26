import { isRedisEnabled, isRedisRequired, redisCommand } from '../redis/client';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

export interface FixedWindowIncrementResult {
  backend: 'redis' | 'memory';
  count: number;
  resetAt: number;
}

const CACHE_PREFIX = 'vormex:';
const TAG_PREFIX = `${CACHE_PREFIX}tag:`;
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

class RedisCacheService {
  private cache = new Map<string, CacheEntry<unknown>>();
  private fixedWindows = new Map<string, FixedWindowEntry>();
  private tagIndex = new Map<string, Set<string>>();

  private key(key: string): string {
    return `${CACHE_PREFIX}${key}`;
  }

  private tagKey(tag: string): string {
    return `${TAG_PREFIX}${tag}`;
  }

  private getRedisClient() {
    return isRedisEnabled() ? redisCommand : null;
  }

  private handleRedisError(error: unknown): void {
    if (isRedisRequired()) {
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const client = this.getRedisClient();
    if (client) {
      try {
        const raw = await client.get(this.key(key));
        return raw ? (JSON.parse(raw) as T) : null;
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = 300, tags: string[] = []): Promise<void> {
    const client = this.getRedisClient();
    if (client) {
      try {
        const redisKey = this.key(key);
        await client.set(redisKey, JSON.stringify(value), 'EX', ttlSeconds);
        if (tags.length > 0) {
          const pipeline = client.multi();
          for (const tag of tags) {
            pipeline.sadd(this.tagKey(tag), redisKey);
            pipeline.expire(this.tagKey(tag), ttlSeconds);
          }
          await pipeline.exec();
        }
      } catch (error) {
        this.handleRedisError(error);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag) || new Set<string>();
      keys.add(key);
      this.tagIndex.set(tag, keys);
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
    this.cache.delete(key);
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
        this.cache.delete(key);
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
      for (const key of keys) {
        this.cache.delete(key);
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
    const entry = this.cache.get(key);
    return Boolean(entry && entry.expiresAt > Date.now());
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
      backend: isRedisEnabled() ? 'redis' : 'memory',
      keys: this.cache.size,
      rateWindows: this.fixedWindows.size,
    };
  }
}

export const redisCacheService = new RedisCacheService();
