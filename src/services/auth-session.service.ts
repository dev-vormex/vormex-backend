import crypto from 'node:crypto';
import { redisCacheService } from '../infrastructure/cache/redis-cache.service';
import { redisCommand } from '../infrastructure/redis/client';

const SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL_SECONDS || 60 * 60 * 24 * 365);

export type StoredSession = {
  sessionId: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
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

function parseRefreshToken(refreshToken: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret] = refreshToken.split('.');
  if (!sessionId || !secret) {
    return null;
  }
  return { sessionId, secret };
}

async function storeSession(session: StoredSession): Promise<void> {
  const ttlSeconds = Math.max(
    60,
    Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
  );

  await redisCacheService.set(sessionKey(session.sessionId), session, ttlSeconds, [
    `auth:user:${session.userId}`,
  ]);

  if (redisCommand) {
    await redisCommand.sadd(`vormex:${userSessionsKey(session.userId)}`, session.sessionId).catch(() => undefined);
    await redisCommand.expire(`vormex:${userSessionsKey(session.userId)}`, ttlSeconds).catch(() => undefined);
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
  if (!existing || existing.refreshTokenHash !== hashSecret(parsed.secret)) {
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

  if (existing?.userId && redisCommand) {
    await redisCommand.srem(`vormex:${userSessionsKey(existing.userId)}`, parsed.sessionId).catch(() => undefined);
  }
}

export async function revokeAllAuthSessions(userId: string): Promise<void> {
  const sessionsKey = `vormex:${userSessionsKey(userId)}`;
  const sessionIds = redisCommand ? await redisCommand.smembers(sessionsKey).catch(() => []) : [];

  await Promise.allSettled(
    sessionIds.map((sessionId) => redisCacheService.del(sessionKey(sessionId)))
  );

  if (redisCommand) {
    await redisCommand.del(sessionsKey).catch(() => undefined);
  }
}
