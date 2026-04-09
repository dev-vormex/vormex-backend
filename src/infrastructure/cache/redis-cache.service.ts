import { redisCommand } from '../redis/client';

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

  async get<T>(key: string): Promise<T | null> {
    if (redisCommand) {
      try {
        const raw = await redisCommand.get(this.key(key));
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
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
    if (redisCommand) {
      try {
        const redisKey = this.key(key);
        await redisCommand.set(redisKey, JSON.stringify(value), 'EX', ttlSeconds);
        if (tags.length > 0) {
          const pipeline = redisCommand.multi();
          for (const tag of tags) {
            pipeline.sadd(this.tagKey(tag), redisKey);
            pipeline.expire(this.tagKey(tag), ttlSeconds);
          }
          await pipeline.exec();
        }
      } catch {
        // Fall back to memory below.
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
    if (redisCommand) {
      await redisCommand.del(this.key(key)).catch(() => undefined);
    }
    this.cache.delete(key);
  }

  async delPattern(pattern: string): Promise<void> {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);

    if (redisCommand) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redisCommand.scan(
          cursor,
          'MATCH',
          this.key(pattern),
          'COUNT',
          100
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await redisCommand.del(...keys);
        }
      } while (cursor !== '0');
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

    if (redisCommand) {
      const keysToDelete = new Set<string>();
      for (const tag of uniqueTags) {
        const members = await redisCommand.smembers(this.tagKey(tag)).catch(() => []);
        members.forEach((member) => keysToDelete.add(member));
      }

      const pipeline = redisCommand.multi();
      if (keysToDelete.size > 0) {
        pipeline.del(...Array.from(keysToDelete));
      }
      for (const tag of uniqueTags) {
        pipeline.del(this.tagKey(tag));
      }
      await pipeline.exec().catch(() => undefined);
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
    if (redisCommand) {
      return (await redisCommand.exists(this.key(key)).catch(() => 0)) === 1;
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

    if (redisCommand) {
      try {
        const redisKey = this.key(fixedWindowKey);
        const pipeline = redisCommand.multi();
        pipeline.incr(redisKey);
        pipeline.pttl(redisKey);
        const results = await pipeline.exec();
        const count = Number(results?.[0]?.[1] || 0);
        let ttlMs = Number(results?.[1]?.[1] || 0);
        if (ttlMs <= 0) {
          ttlMs = Math.max(1_000, resetAt - now);
          await redisCommand.pexpire(redisKey, ttlMs);
        }
        return {
          backend: 'redis',
          count,
          resetAt: now + ttlMs,
        };
      } catch {
        // Fall back to memory below.
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
      backend: redisCommand ? 'redis' : 'memory',
      keys: this.cache.size,
      rateWindows: this.fixedWindows.size,
    };
  }
}

export const redisCacheService = new RedisCacheService();
