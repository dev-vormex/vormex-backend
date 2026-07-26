import { isRedisEnabled, redisCommand } from '../infrastructure/redis/client';

const AUTH_USER_STATUS_CACHE_TTL_SECONDS = 60;
const AUTH_USER_STATUS_ALLOWED = '1';
const AUTH_USER_STATUS_DENIED = '0';
const AUTH_USER_STATUS_LOCAL_CACHE_MAX_ENTRIES = 10_000;

type LocalAuthStatusEntry = {
  allowed: boolean;
  expiresAt: number;
};

// Redis remains primary; this bounded LRU prevents a DB lookup per request during outages.
const localAuthStatusCache = new Map<string, LocalAuthStatusEntry>();

function authUserStatusCacheKey(userId: string): string {
  return `auth:user-status:${userId}`;
}

function getLocalAuthUserStatus(userId: string): boolean | null {
  const entry = localAuthStatusCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    localAuthStatusCache.delete(userId);
    return null;
  }

  // Refresh insertion order on access to keep recently used users in the LRU.
  localAuthStatusCache.delete(userId);
  localAuthStatusCache.set(userId, entry);
  return entry.allowed;
}

function setLocalAuthUserStatus(userId: string, allowed: boolean): void {
  localAuthStatusCache.delete(userId);
  localAuthStatusCache.set(userId, {
    allowed,
    expiresAt: Date.now() + AUTH_USER_STATUS_CACHE_TTL_SECONDS * 1000,
  });

  while (localAuthStatusCache.size > AUTH_USER_STATUS_LOCAL_CACHE_MAX_ENTRIES) {
    const oldestKey = localAuthStatusCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    localAuthStatusCache.delete(oldestKey);
  }
}

export async function getCachedAuthUserStatus(userId: string): Promise<boolean | null> {
  const key = authUserStatusCacheKey(userId);
  let cached: string | null = null;
  if (isRedisEnabled() && redisCommand) {
    try {
      cached = await redisCommand.get(key);
    } catch (error) {
      return getLocalAuthUserStatus(userId);
    }
  }
  if (cached === AUTH_USER_STATUS_ALLOWED) {
    setLocalAuthUserStatus(userId, true);
    return true;
  }
  if (cached === AUTH_USER_STATUS_DENIED) {
    setLocalAuthUserStatus(userId, false);
    return false;
  }
  return getLocalAuthUserStatus(userId);
}

export async function setCachedAuthUserStatus(userId: string, allowed: boolean): Promise<void> {
  const key = authUserStatusCacheKey(userId);
  const value = allowed ? AUTH_USER_STATUS_ALLOWED : AUTH_USER_STATUS_DENIED;
  setLocalAuthUserStatus(userId, allowed);
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
  const normalizedUserId = String(userId);
  const key = authUserStatusCacheKey(normalizedUserId);
  localAuthStatusCache.delete(normalizedUserId);
  if (isRedisEnabled() && redisCommand) {
    try {
      await redisCommand.del(key);
    } catch (error) {
      return;
    }
  }
}
