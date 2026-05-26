import { isRedisEnabled, redisCommand } from '../infrastructure/redis/client';

const AUTH_USER_STATUS_CACHE_TTL_SECONDS = 60;
const AUTH_USER_STATUS_ALLOWED = '1';
const AUTH_USER_STATUS_DENIED = '0';

function authUserStatusCacheKey(userId: string): string {
  return `auth:user-status:${userId}`;
}

export async function getCachedAuthUserStatus(userId: string): Promise<boolean | null> {
  const key = authUserStatusCacheKey(userId);
  let cached: string | null = null;
  if (isRedisEnabled() && redisCommand) {
    try {
      cached = await redisCommand.get(key);
    } catch (error) {
      return null;
    }
  }
  if (cached === AUTH_USER_STATUS_ALLOWED) return true;
  if (cached === AUTH_USER_STATUS_DENIED) return false;
  return null;
}

export async function setCachedAuthUserStatus(userId: string, allowed: boolean): Promise<void> {
  const key = authUserStatusCacheKey(userId);
  const value = allowed ? AUTH_USER_STATUS_ALLOWED : AUTH_USER_STATUS_DENIED;
  if (isRedisEnabled() && redisCommand) {
    try {
      await redisCommand.set(key, value, 'EX', AUTH_USER_STATUS_CACHE_TTL_SECONDS);
    } catch (error) {
      return;
    }
  }
}

export async function invalidateAuthUserStatus(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const key = authUserStatusCacheKey(String(userId));
  if (isRedisEnabled() && redisCommand) {
    try {
      await redisCommand.del(key);
    } catch (error) {
      return;
    }
  }
}
