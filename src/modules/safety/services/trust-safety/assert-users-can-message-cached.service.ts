import { prisma } from "../../../../config/prisma";
import { evaluateRateLimit } from "../../../../infrastructure/security/rate-limit.service";
import { messageInteractionMemo, TrustLimitedAction, IdentityTrustLevel, ACTION_LIMITS, TRUST_LEVELS, ACTION_WINDOW_SECONDS, SafetyActionError, identityTrustLevelMemo } from "./safety-action-error.service";
import { messageInteractionKey } from "./invalidate-message-interaction-cache.service";
import { assertUsersCanInteract } from "./create-user-block-with-device-scope.service";

export async function assertUsersCanMessageCached(
  actorId: string,
  targetUserId: string
): Promise<void> {
  return messageInteractionMemo.get(
    messageInteractionKey(actorId, targetUserId),
    () => assertUsersCanInteract(actorId, targetUserId, 'message')
  );
}

function trustLimitEnvName(action: TrustLimitedAction, level: IdentityTrustLevel): string {
  return `TRUST_LIMIT_${action.toUpperCase()}_${level}`;
}

export async function enforceTrustTierLimit(
  userId: string,
  action: TrustLimitedAction
): Promise<void> {
  const level = await getIdentityTrustLevelCached(userId);
  const configured = Number(process.env[trustLimitEnvName(action, level)]);
  const limit = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : ACTION_LIMITS[action][TRUST_LEVELS.includes(level) ? level : 'BASIC'];
  const result = await evaluateRateLimit(userId, {
    keyPrefix: `rate:user:trust:${action}`,
    limit,
    windowSeconds: ACTION_WINDOW_SECONDS[action],
    code: 'trust_tier_rate_limited',
    message: 'This action is cooling down for your current trust tier.',
  });

  if (!result.allowed) {
    throw new SafetyActionError(
      'This action is cooling down for your current trust tier.',
      'trust_tier_rate_limited',
      429,
      result.retryAfterSeconds
    );
  }
}

export async function getIdentityTrustLevelCached(userId: string): Promise<IdentityTrustLevel> {
  return identityTrustLevelMemo.get(userId, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { identityTrustLevel: true },
    });
    return (user?.identityTrustLevel || 'BASIC') as IdentityTrustLevel;
  });
}

export function safetyErrorResponse(error: unknown): {
  statusCode: number;
  body: { error: string; code: string; retryable: boolean; retryAfterSeconds?: number };
} | null {
  if (!(error instanceof SafetyActionError)) return null;
  return {
    statusCode: error.statusCode,
    body: {
      error: error.message,
      code: error.code,
      retryable: error.code === 'user_blocked' || error.code === 'resource_unavailable'
        ? false
        : error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
    },
  };
}
