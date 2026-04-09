import { cacheService } from './cache.service';
import { logger } from '../lib/logger';

type AIRateLimitScope = 'helper' | 'career-chat';

interface RateLimitBucketResult {
  backend: 'redis' | 'memory';
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

interface AIRateLimitCheckParams {
  ip: string;
  requestId: string;
  scope: AIRateLimitScope;
  userId?: string;
}

interface AIRateLimitCheckResult {
  allowed: boolean;
  blockedBy?: 'user' | 'ip';
  effective: RateLimitBucketResult;
  ipBucket: RateLimitBucketResult;
  userBucket?: RateLimitBucketResult;
}

const WINDOW_SECONDS = 5 * 60;

const SCOPE_LIMITS: Record<AIRateLimitScope, { user: number; ip: number }> = {
  helper: {
    user: 30,
    ip: 100,
  },
  'career-chat': {
    user: 12,
    ip: 40,
  },
};

class AIRateLimitService {
  private fallbackWarningByScope = new Map<string, number>();

  private maybeLogMemoryFallback(scope: AIRateLimitScope, requestId: string): void {
    if (!process.env.REDIS_URL) {
      return;
    }

    const now = Date.now();
    const key = `ai-rate:${scope}`;
    const previous = this.fallbackWarningByScope.get(key) || 0;

    if (now - previous < 60_000) {
      return;
    }

    this.fallbackWarningByScope.set(key, now);
    logger.warn({
      event: 'ai.redis.fallback',
      requestId,
      scope,
      reason: 'redis_unavailable',
    });
  }

  private async evaluateBucket(params: {
    identifier: string;
    keyType: 'user' | 'ip';
    limit: number;
    requestId: string;
    scope: AIRateLimitScope;
  }): Promise<RateLimitBucketResult> {
    const { identifier, keyType, limit, requestId, scope } = params;
    const result = await cacheService.incrementFixedWindow(
      `ai:rate-limit:${scope}:${keyType}:${identifier}`,
      WINDOW_SECONDS
    );

    if (result.backend === 'memory') {
      this.maybeLogMemoryFallback(scope, requestId);
    }

    return {
      backend: result.backend,
      allowed: result.count <= limit,
      limit,
      remaining: Math.max(limit - result.count, 0),
      resetAt: result.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
    };
  }

  async checkLimit(params: AIRateLimitCheckParams): Promise<AIRateLimitCheckResult> {
    const { ip, requestId, scope, userId } = params;
    const limits = SCOPE_LIMITS[scope];

    const userBucket = userId
      ? await this.evaluateBucket({
          identifier: userId,
          keyType: 'user',
          limit: limits.user,
          requestId,
          scope,
        })
      : undefined;

    if (userBucket && !userBucket.allowed) {
      return {
        allowed: false,
        blockedBy: 'user',
        effective: userBucket,
        userBucket,
        ipBucket: userBucket,
      };
    }

    const ipBucket = await this.evaluateBucket({
      identifier: ip,
      keyType: 'ip',
      limit: limits.ip,
      requestId,
      scope,
    });

    if (!ipBucket.allowed) {
      return {
        allowed: false,
        blockedBy: 'ip',
        effective: ipBucket,
        userBucket,
        ipBucket,
      };
    }

    const effective =
      userBucket && userBucket.remaining <= ipBucket.remaining
        ? userBucket
        : ipBucket;

    return {
      allowed: true,
      effective,
      userBucket,
      ipBucket,
    };
  }
}

export const aiRateLimitService = new AIRateLimitService();
export type { AIRateLimitScope, AIRateLimitCheckResult };
