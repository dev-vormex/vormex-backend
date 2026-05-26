import { redisCacheService } from '../infrastructure/cache/redis-cache.service';
import type { FixedWindowIncrementResult } from '../infrastructure/cache/redis-cache.service';

class BackendCacheService {
  async get<T>(key: string): Promise<T | null> {
    return redisCacheService.get<T>(key);
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds = 300,
    tags: string[] = []
  ): Promise<void> {
    return redisCacheService.set(key, value, ttlSeconds, tags);
  }

  async del(key: string): Promise<void> {
    return redisCacheService.del(key);
  }

  async delPattern(pattern: string): Promise<void> {
    return redisCacheService.delPattern(pattern);
  }

  async invalidateTags(...tags: string[]): Promise<void> {
    return redisCacheService.invalidateTags(...tags);
  }

  async exists(key: string): Promise<boolean> {
    return redisCacheService.exists(key);
  }

  async incrementFixedWindow(
    key: string,
    windowSeconds: number
  ): Promise<FixedWindowIncrementResult> {
    return redisCacheService.incrementFixedWindow(key, windowSeconds);
  }

  getStats() {
    return {
      ...redisCacheService.getStats(),
      applicationCacheEnabled: true,
    };
  }
}

export const cacheService = new BackendCacheService();
