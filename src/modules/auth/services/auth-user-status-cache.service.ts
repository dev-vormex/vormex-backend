import { isRedisEnabled, redisCommand } from '../../../infrastructure/redis/client';

const AUTH_USER_STATUS_CACHE_TTL_SECONDS = 60;
const AUTH_USER_STATUS_ALLOWED = '1';
const AUTH_USER_STATUS_DENIED = '0';
const AUTH_USER_STATUS_LOCAL_CACHE_MAX_ENTRIES = 10_000;

/**
 * How long an in-process answer is trusted *while Redis is healthy*.
 *
 * Redis used to be consulted on every authenticated request even when this
 * process already held a fresh answer, so the local map only ever served during
 * an outage. That cost one network round trip per request. A screen load fires a
 * burst of requests for the same user within a second or two, and serving that
 * burst from process memory removes the round trip from all but the first.
 *
 * This window is the ceiling on how long a revoked status can still read as
 * allowed on an instance whose entry is warm. Five seconds is safe because this
 * is not the only gate: every restrictive admin action (ban, suspend, delete)
 * also calls `revokeAllAuthSessions`, and the session is read from Redis on
 * every request with no local caching at all. A ban therefore still takes effect
 * on the very next request — this window only delays the secondary DB-backed
 * checks, and only on instances that have seen the user in the last few seconds.
 */
const AUTH_USER_STATUS_LOCAL_TTL_SECONDS = (() => {
  const configured = Number.parseInt(process.env.AUTH_USER_STATUS_LOCAL_TTL_SECONDS || '', 10);
  if (!Number.isFinite(configured) || configured < 0) return 5;
  return Math.min(configured, AUTH_USER_STATUS_CACHE_TTL_SECONDS);
})();

type LocalAuthStatusEntry = {
  allowed: boolean;
  /** Trusted without contacting Redis until this moment. */
  freshUntil: number;
  /** Still usable after `freshUntil`, but only when Redis cannot be reached. */
  fallbackUntil: number;
};

// Bounded LRU serving two distinct jobs: the fast path for request bursts, and
// a degraded-mode answer that keeps a Redis outage from becoming a DB lookup per
// request. The two TTLs above are what separate those jobs.
const localAuthStatusCache = new Map<string, LocalAuthStatusEntry>();

export function authUserStatusCacheKey(userId: string): string {
  return `auth:user-status:${userId}`;
}

/** Decodes a raw Redis value. Exported so a pipelined read can reuse it. */
export function decodeAuthUserStatus(raw: string | null | undefined): boolean | null {
  if (raw === AUTH_USER_STATUS_ALLOWED) return true;
  if (raw === AUTH_USER_STATUS_DENIED) return false;
  return null;
}

function readLocalEntry(userId: string): LocalAuthStatusEntry | null {
  const entry = localAuthStatusCache.get(userId);
  if (!entry) return null;
  if (entry.fallbackUntil <= Date.now()) {
    localAuthStatusCache.delete(userId);
    return null;
  }

  // Refresh insertion order on access to keep recently used users in the LRU.
  localAuthStatusCache.delete(userId);
  localAuthStatusCache.set(userId, entry);
  return entry;
}

/** Fresh enough to answer without asking Redis. */
export function getFreshLocalAuthUserStatus(userId: string): boolean | null {
  const entry = readLocalEntry(userId);
  if (!entry || entry.freshUntil <= Date.now()) return null;
  return entry.allowed;
}

/** Any usable local answer, including a stale one. Only for Redis outages. */
export function getLocalAuthUserStatus(userId: string): boolean | null {
  return readLocalEntry(userId)?.allowed ?? null;
}

export function setLocalAuthUserStatus(userId: string, allowed: boolean): void {
  const now = Date.now();
  localAuthStatusCache.delete(userId);
  localAuthStatusCache.set(userId, {
    allowed,
    freshUntil: now + AUTH_USER_STATUS_LOCAL_TTL_SECONDS * 1000,
    fallbackUntil: now + AUTH_USER_STATUS_CACHE_TTL_SECONDS * 1000,
  });

  while (localAuthStatusCache.size > AUTH_USER_STATUS_LOCAL_CACHE_MAX_ENTRIES) {
    const oldestKey = localAuthStatusCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    localAuthStatusCache.delete(oldestKey);
  }
}

export async function getCachedAuthUserStatus(userId: string): Promise<boolean | null> {
  const fresh = getFreshLocalAuthUserStatus(userId);
  if (fresh !== null) {
    return fresh;
  }

  if (!isRedisEnabled() || !redisCommand) {
    return getLocalAuthUserStatus(userId);
  }

  let cached: string | null = null;
  try {
    cached = await redisCommand.get(authUserStatusCacheKey(userId));
  } catch {
    return getLocalAuthUserStatus(userId);
  }

  const decoded = decodeAuthUserStatus(cached);
  if (decoded !== null) {
    setLocalAuthUserStatus(userId, decoded);
    return decoded;
  }
  // Redis answered and had nothing. The local entry is past its fresh window, so
  // it must not override that — fall through to the authoritative DB lookup.
  return null;
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
