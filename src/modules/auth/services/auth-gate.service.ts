/**
 * The authentication gate: everything Redis-backed that has to be true before a
 * request is allowed to reach a route handler.
 *
 * This module exists for one reason — round trips. The two checks it performs
 * (is the session still active, is the account still allowed to authenticate)
 * used to run as two sequential awaits inside `verifyAccessToken`, so every
 * authenticated request paid two serial Redis latencies before routing. They are
 * independent reads against the same client, so they are pipelined into one.
 *
 * The DB fallback for account status is unchanged and still authoritative; it
 * only runs when neither the local cache nor Redis can answer.
 */

import { prisma } from '../../../config/prisma';
import { isRedisEnabled, redisCommand } from '../../../infrastructure/redis/client';
import { authSessionRedisKey, authUserSessionVersionRedisKey, dropExpiredAuthSession, getAuthSession, isStoredSessionExpired, isStoredSessionVersionCurrent, type StoredSession } from './auth-session.service';
import { authUserStatusCacheKey, decodeAuthUserStatus, getFreshLocalAuthUserStatus, getLocalAuthUserStatus, setCachedAuthUserStatus, setLocalAuthUserStatus } from './auth-user-status-cache.service';

export interface AuthGateInput {
  sessionId?: string;
  userId: string;
  /** When false, the session read is skipped entirely (session binding is off). */
  requireSession: boolean;
}

export type AuthGateFailure =
  | 'session_missing'
  | 'session_inactive'
  | 'user_missing'
  | 'user_banned'
  | 'user_suspended'
  | 'email_unverified'
  /** A cached denial, which cannot say which of the reasons above applied. */
  | 'user_denied_cached';

/**
 * Shaped like the other `{ ok, … }` results in this codebase rather than as a
 * discriminated union: `strict` is off in tsconfig, so a `ok: true | false`
 * discriminant does not narrow for callers.
 */
export interface AuthGateResult {
  ok: boolean;
  reason?: AuthGateFailure;
}

/**
 * These strings are load-bearing. `authenticate` in auth.middleware.ts selects
 * the client-facing error code by substring-matching them, so changing the
 * wording changes the API contract.
 */
const AUTH_GATE_FAILURE_MESSAGES: Record<AuthGateFailure, string> = {
  session_missing: 'Session is no longer active',
  session_inactive: 'Session is no longer active',
  user_missing: 'User account no longer exists',
  user_banned: 'User account is disabled',
  user_suspended: 'User account is suspended',
  email_unverified: 'Email verification required',
  user_denied_cached: 'User account is disabled or email verification required',
};

export function authGateFailureMessage(reason: AuthGateFailure | undefined): string {
  return (reason && AUTH_GATE_FAILURE_MESSAGES[reason]) || 'Token verification failed';
}

function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

/**
 * Resolves the account-status answer from the authoritative table and writes it
 * back through the normal cache path.
 */
async function loadAccountStatusFromDatabase(userId: string): Promise<AuthGateResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      authProvider: true,
      isBanned: true,
      isVerified: true,
      safetySuspendedUntil: true,
    },
  });

  const deny = async (reason: AuthGateFailure): Promise<AuthGateResult> => {
    await setCachedAuthUserStatus(userId, false);
    return { ok: false, reason };
  };

  if (!user) return deny('user_missing');
  if (user.isBanned) return deny('user_banned');
  if (user.safetySuspendedUntil && user.safetySuspendedUntil > new Date()) {
    return deny('user_suspended');
  }
  if (user.authProvider === 'email' && !user.isVerified) {
    return deny('email_unverified');
  }

  await setCachedAuthUserStatus(userId, true);
  return { ok: true };
}

/**
 * A cached `false` cannot say *why* it is false — the cache is a single bit.
 * This preserves the previous behaviour, where a cached denial surfaced to the
 * client as `auth_not_allowed` rather than a specific reason.
 */
const CACHED_DENIAL: AuthGateResult = { ok: false, reason: 'user_denied_cached' };

/**
 * Reads both gate inputs in one Redis round trip and resolves the result.
 *
 * Fast path: when this process already holds a fresh account-status answer, only
 * the session key is fetched. When the session read is not required either, no
 * Redis call happens at all.
 */
export async function evaluateAuthGate(input: AuthGateInput): Promise<AuthGateResult> {
  const { userId, requireSession } = input;
  const sessionId = input.sessionId;

  if (requireSession && !sessionId) {
    return { ok: false, reason: 'session_missing' };
  }

  const freshStatus = getFreshLocalAuthUserStatus(userId);
  const needsStatusRead = freshStatus === null;
  const needsSessionRead = requireSession && Boolean(sessionId);

  if (freshStatus === false) {
    return CACHED_DENIAL;
  }

  // Nothing to fetch: session binding is off and the status is locally fresh.
  if (!needsSessionRead && !needsStatusRead) {
    return { ok: true };
  }

  const client = isRedisEnabled() ? redisCommand : null;

  if (!client) {
    // Degraded mode. Fall back to the individual paths, which already know how
    // to answer without Redis.
    if (needsSessionRead) {
      const session = await getAuthSession(sessionId as string);
      if (!session || session.userId !== userId) {
        return { ok: false, reason: 'session_inactive' };
      }
    }
    if (!needsStatusRead) return { ok: true };
    const stale = getLocalAuthUserStatus(userId);
    if (stale === true) return { ok: true };
    if (stale === false) return CACHED_DENIAL;
    return loadAccountStatusFromDatabase(userId);
  }

  const keys: string[] = [];
  if (needsSessionRead) {
    keys.push(authSessionRedisKey(sessionId as string));
    keys.push(authUserSessionVersionRedisKey(userId));
  }
  if (needsStatusRead) keys.push(authUserStatusCacheKey(userId));

  let values: Array<string | null>;
  try {
    values = await client.mget(...keys);
  } catch {
    // Same degraded handling as above, without re-reading Redis.
    if (needsSessionRead) {
      const session = await getAuthSession(sessionId as string).catch(() => null);
      if (!session || session.userId !== userId) {
        return { ok: false, reason: 'session_inactive' };
      }
    }
    if (!needsStatusRead) return { ok: true };
    const stale = getLocalAuthUserStatus(userId);
    if (stale === true) return { ok: true };
    if (stale === false) return CACHED_DENIAL;
    return loadAccountStatusFromDatabase(userId);
  }

  let cursor = 0;

  if (needsSessionRead) {
    const session = parseStoredSession(values[cursor] ?? null);
    cursor += 1;
    const sessionVersion = values[cursor] ?? null;
    cursor += 1;

    if (!session || session.userId !== userId) {
      return { ok: false, reason: 'session_inactive' };
    }
    if (isStoredSessionExpired(session)) {
      // Mirrors getAuthSession: an expired session is removed on read.
      void dropExpiredAuthSession(sessionId as string).catch(() => undefined);
      return { ok: false, reason: 'session_inactive' };
    }
    if (!isStoredSessionVersionCurrent(session, sessionVersion)) {
      void dropExpiredAuthSession(sessionId as string).catch(() => undefined);
      return { ok: false, reason: 'session_inactive' };
    }
  }

  if (!needsStatusRead) {
    return { ok: true };
  }

  const cachedStatus = decodeAuthUserStatus(values[cursor] ?? null);
  if (cachedStatus === true) {
    setLocalAuthUserStatus(userId, true);
    return { ok: true };
  }
  if (cachedStatus === false) {
    setLocalAuthUserStatus(userId, false);
    return CACHED_DENIAL;
  }

  return loadAccountStatusFromDatabase(userId);
}
