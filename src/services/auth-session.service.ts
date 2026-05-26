import crypto from 'node:crypto';
import { redisCacheService } from '../infrastructure/cache/redis-cache.service';
import { isRedisEnabled, isRedisRequired, redisCommand } from '../infrastructure/redis/client';

const ONE_THOUSAND_DAYS_SECONDS = 60 * 60 * 24 * 1000;
const DEFAULT_SESSION_TTL_SECONDS = ONE_THOUSAND_DAYS_SECONDS;
const MAX_SESSION_TTL_SECONDS = ONE_THOUSAND_DAYS_SECONDS;
const configuredSessionTtlSeconds = Number(
  process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS ||
    process.env.AUTH_SESSION_TTL_SECONDS ||
    DEFAULT_SESSION_TTL_SECONDS
);
const SESSION_TTL_SECONDS = Math.min(
  MAX_SESSION_TTL_SECONDS,
  Math.max(60 * 60, Number.isFinite(configuredSessionTtlSeconds)
    ? configuredSessionTtlSeconds
    : DEFAULT_SESSION_TTL_SECONDS)
);

export type StoredSession = {
  sessionId: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
  adminTwoFactorVerified?: boolean;
};

function sessionKey(sessionId: string): string {
  return `auth:session:${sessionId}`;
}

export async function getAuthSession(sessionId: string): Promise<StoredSession | null> {
  const session = await redisCacheService.get<StoredSession>(sessionKey(sessionId));
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await redisCacheService.del(sessionKey(sessionId));
    return null;
  }

  return session;
}

function userSessionsKey(userId: string): string {
  return `auth:user:${userId}:sessions`;
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

  await redisCacheService.set(sessionKey(session.sessionId), session, ttlSeconds, [
    `auth:user:${session.userId}`,
  ]);

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
}): Promise<{ sessionId: string; refreshToken: string; expiresAt: Date }> {
  const sessionId = crypto.randomUUID();
  const secret = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await storeSession({
    sessionId,
    userId: params.userId,
    refreshTokenHash: hashSecret(secret),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    userAgent: params.userAgent,
    ip: params.ip,
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

  const next = await createAuthSession({
    userId: existing.userId,
    userAgent: existing.userAgent,
    ip: existing.ip,
  });

  await revokeAuthSession(refreshToken);

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

  const existing = await redisCacheService.get<StoredSession>(sessionKey(parsed.sessionId));
  await redisCacheService.del(sessionKey(parsed.sessionId));

  if (existing?.userId && isRedisEnabled() && redisCommand) {
    try {
      await redisCommand.srem(`vormex:${userSessionsKey(existing.userId)}`, parsed.sessionId);
    } catch (error) {
      if (isRedisRequired()) {
        throw error;
      }
    }
  }
}

export async function revokeAllAuthSessions(userId: string): Promise<void> {
  const sessionsKey = `vormex:${userSessionsKey(userId)}`;
  let sessionIds: string[] = [];
  if (isRedisEnabled() && redisCommand) {
    try {
      sessionIds = await redisCommand.smembers(sessionsKey);
    } catch (error) {
      if (isRedisRequired()) {
        throw error;
      }
    }
  }

  await Promise.allSettled(
    sessionIds.map((sessionId) => redisCacheService.del(sessionKey(sessionId)))
  );

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
