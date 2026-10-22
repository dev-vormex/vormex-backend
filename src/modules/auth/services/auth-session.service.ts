import crypto from 'node:crypto';
import { CACHE_KEY_PREFIX, redisSessionStore } from '../../../infrastructure/cache/redis-cache.service';
import { isRedisEnabled, isRedisRequired, redisCommand } from '../../../infrastructure/redis/client';

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

export function getAuthSessionTtlSeconds(): number {
  const configured = Number(
    process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS ||
      process.env.AUTH_SESSION_TTL_SECONDS ||
      DEFAULT_SESSION_TTL_SECONDS
  );
  const seconds = Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_SESSION_TTL_SECONDS;

  return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(60 * 60, seconds));
}

export type StoredSession = {
  sessionId: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
  adminTwoFactorVerified?: boolean;
  userSessionVersion?: number;
};

const localUserSessionVersions = new Map<string, number>();
const localUserSessions = new Map<string, Set<string>>();
let localSessionMutationChain: Promise<void> = Promise.resolve();

function sessionKey(sessionId: string): string {
  return `auth:session:${sessionId}`;
}

/**
 * The fully namespaced Redis key for a session.
 *
 * The auth gate reads this key through the raw client so it can be pipelined
 * with the user-status key in a single round trip. Anything reading it that way
 * must build the key here rather than duplicating the prefix.
 */
export function authSessionRedisKey(sessionId: string): string {
  return `${CACHE_KEY_PREFIX}${sessionKey(sessionId)}`;
}

export function isStoredSessionExpired(session: StoredSession): boolean {
  return new Date(session.expiresAt).getTime() <= Date.now();
}

/** Drops a session that was found expired by a raw pipelined read. */
export async function dropExpiredAuthSession(sessionId: string): Promise<void> {
  await redisSessionStore.del(sessionKey(sessionId));
}

export async function getAuthSession(sessionId: string): Promise<StoredSession | null> {
  const session = await redisSessionStore.get<StoredSession>(sessionKey(sessionId));
  if (!session) {
    return null;
  }

  if (isStoredSessionExpired(session)) {
    await redisSessionStore.del(sessionKey(sessionId));
    return null;
  }

  const currentVersion = await getUserSessionVersion(session.userId);
  if ((session.userSessionVersion || 0) !== currentVersion) {
    await redisSessionStore.del(sessionKey(sessionId));
    localUserSessions.get(session.userId)?.delete(sessionId);
    return null;
  }

  return session;
}

function userSessionsKey(userId: string): string {
  return `auth:user:${userId}:sessions`;
}

function userSessionVersionKey(userId: string): string {
  return `auth:user:${userId}:version`;
}

export function authUserSessionVersionRedisKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userSessionVersionKey(userId)}`;
}

export function isStoredSessionVersionCurrent(
  session: StoredSession,
  rawVersion: string | null | undefined
): boolean {
  const currentVersion = Number.parseInt(rawVersion || '0', 10) || 0;
  return (session.userSessionVersion || 0) === currentVersion;
}

async function getUserSessionVersion(userId: string): Promise<number> {
  if (isRedisEnabled() && redisCommand) {
    try {
      const raw = await redisCommand.get(authUserSessionVersionRedisKey(userId));
      const version = Number.parseInt(raw || '0', 10) || 0;
      localUserSessionVersions.set(userId, version);
      return version;
    } catch (error) {
      if (isRedisRequired()) throw error;
    }
  }
  return localUserSessionVersions.get(userId) || 0;
}

async function incrementUserSessionVersion(userId: string): Promise<number> {
  if (isRedisEnabled() && redisCommand) {
    try {
      const version = await redisCommand.incr(authUserSessionVersionRedisKey(userId));
      localUserSessionVersions.set(userId, version);
      return version;
    } catch (error) {
      if (isRedisRequired()) throw error;
    }
  }
  const version = (localUserSessionVersions.get(userId) || 0) + 1;
  localUserSessionVersions.set(userId, version);
  return version;
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseRefreshToken(refreshToken: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret] = refreshToken.split('.');
  if (!sessionId || !secret) {
    return null;
  }
  return { sessionId, secret };
}

export function getRefreshTokenSessionId(refreshToken: string | undefined): string | null {
  if (!refreshToken) {
    return null;
  }

  return parseRefreshToken(refreshToken)?.sessionId ?? null;
}

async function storeSession(session: StoredSession): Promise<void> {
  const ttlSeconds = Math.max(
    60,
    Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
  );

  await redisSessionStore.set(sessionKey(session.sessionId), session, ttlSeconds, [
    `auth:user:${session.userId}`,
  ]);

  const localIndex = localUserSessions.get(session.userId) || new Set<string>();
  localIndex.add(session.sessionId);
  localUserSessions.set(session.userId, localIndex);

  if (isRedisEnabled() && redisCommand) {
    try {
      await redisCommand.sadd(`vormex:${userSessionsKey(session.userId)}`, session.sessionId);
      await redisCommand.expire(`vormex:${userSessionsKey(session.userId)}`, ttlSeconds);
    } catch (error) {
      if (isRedisRequired()) {
        throw error;
      }
    }
  }
}

export async function createAuthSession(params: {
  userId: string;
  userAgent?: string;
  ip?: string;
  /** Rotation inherits its consumed session generation so logout-all always wins a race. */
  userSessionVersion?: number;
}): Promise<{ sessionId: string; refreshToken: string; expiresAt: Date }> {
  const sessionId = crypto.randomUUID();
  const secret = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + getAuthSessionTtlSeconds() * 1000);
  const userSessionVersion = params.userSessionVersion
    ?? await getUserSessionVersion(params.userId);

  await storeSession({
    sessionId,
    userId: params.userId,
    refreshTokenHash: hashSecret(secret),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    userAgent: params.userAgent,
    ip: params.ip,
    userSessionVersion,
  });

  return {
    sessionId,
    refreshToken: `${sessionId}.${secret}`,
    expiresAt,
  };
}

export async function rotateAuthSession(refreshToken: string): Promise<{
  userId: string;
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
} | null> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) {
    return null;
  }

  const existing = await getAuthSession(parsed.sessionId);
  if (
    !existing ||
    !timingSafeStringEqual(existing.refreshTokenHash, hashSecret(parsed.secret))
  ) {
    return null;
  }

  const consumed = await consumeAuthSession(parsed.sessionId, parsed.secret);
  if (!consumed) {
    return null;
  }

  const next = await createAuthSession({
    userId: existing.userId,
    userAgent: existing.userAgent,
    ip: existing.ip,
    userSessionVersion: existing.userSessionVersion || 0,
  });

  return {
    userId: existing.userId,
    sessionId: next.sessionId,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
  };
}

export async function revokeAuthSession(refreshToken: string): Promise<void> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) {
    return;
  }

  await consumeAuthSession(parsed.sessionId, parsed.secret);
}

export async function revokeAllAuthSessions(userId: string): Promise<void> {
  // This monotonic generation is the security boundary. Even if an old
  // session is missing from the cleanup index, it is rejected on its next use.
  await incrementUserSessionVersion(userId);
  const sessionsKey = `vormex:${userSessionsKey(userId)}`;
  let sessionIds: string[] = Array.from(localUserSessions.get(userId) || []);
  if (isRedisEnabled() && redisCommand) {
    try {
      sessionIds = Array.from(new Set([...sessionIds, ...(await redisCommand.smembers(sessionsKey))]));
    } catch (error) {
      if (isRedisRequired()) {
        throw error;
      }
    }
  }

  await Promise.all(
    sessionIds.map((sessionId) => redisSessionStore.del(sessionKey(sessionId)))
  );
  localUserSessions.delete(userId);

  if (isRedisEnabled() && redisCommand) {
    try {
      await redisCommand.del(sessionsKey);
    } catch (error) {
      if (isRedisRequired()) {
        throw error;
      }
    }
  }
}

async function withLocalSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = localSessionMutationChain;
  let release!: () => void;
  localSessionMutationChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function consumeAuthSession(sessionId: string, secret: string): Promise<StoredSession | null> {
  const expectedHash = hashSecret(secret);

  if (isRedisEnabled() && redisCommand) {
    try {
      const raw = await redisCommand.eval(
        `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local ok, session = pcall(cjson.decode, raw)
if not ok or session.refreshTokenHash ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
if session.userId then
  redis.call('SREM', ARGV[2] .. session.userId .. ':sessions', ARGV[3])
end
return raw
        `,
        1,
        authSessionRedisKey(sessionId),
        expectedHash,
        `${CACHE_KEY_PREFIX}auth:user:`,
        sessionId
      );
      if (!raw || typeof raw !== 'string') return null;
      const consumed = JSON.parse(raw) as StoredSession;
      // The Lua script removed Redis state atomically; this second deletion
      // clears the process-local mirror maintained by RedisCacheService.
      await redisSessionStore.del(sessionKey(sessionId));
      localUserSessions.get(consumed.userId)?.delete(sessionId);
      return consumed;
    } catch (error) {
      if (isRedisRequired()) throw error;
    }
  }

  return withLocalSessionMutation(async () => {
    const existing = await redisSessionStore.get<StoredSession>(sessionKey(sessionId));
    if (!existing || !timingSafeStringEqual(existing.refreshTokenHash, expectedHash)) {
      return null;
    }
    await redisSessionStore.del(sessionKey(sessionId));
    localUserSessions.get(existing.userId)?.delete(sessionId);
    return existing;
  });
}

export async function markAuthSessionTwoFactorVerified(
  sessionId: string | undefined,
  userId: string
): Promise<boolean> {
  if (!sessionId) {
    return false;
  }

  const session = await getAuthSession(sessionId);
  if (!session || session.userId !== userId) {
    return false;
  }

  await storeSession({
    ...session,
    adminTwoFactorVerified: true,
  });

  return true;
}

export async function isAuthSessionTwoFactorVerified(
  sessionId: string | undefined,
  userId: string
): Promise<boolean> {
  if (!sessionId) {
    return false;
  }

  const session = await getAuthSession(sessionId);
  return Boolean(session && session.userId === userId && session.adminTwoFactorVerified);
}
