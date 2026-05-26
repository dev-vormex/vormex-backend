import { cacheService } from './cache.service';
import { logger } from '../lib/logger';

type AIRateLimitScope = 'helper' | 'career-chat' | 'talk';

interface AIRateLimitWindow {
  ip: number;
  name: string;
  seconds: number;
  user: number;
}

interface RateLimitBucketResult {
  backend: 'redis' | 'memory';
  allowed: boolean;
  keyType: 'user' | 'ip';
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  window: string;
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
  buckets: RateLimitBucketResult[];
  effective: RateLimitBucketResult;
  ipBucket?: RateLimitBucketResult;
  userBucket?: RateLimitBucketResult;
}

const FIVE_MINUTES = 5 * 60;
const HOUR = 60 * 60;

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const SCOPE_LIMITS: Record<AIRateLimitScope, AIRateLimitWindow[]> = {
  helper: [
    {
      name: 'burst',
      seconds: FIVE_MINUTES,
      user: intEnv('RATE_LIMIT_AI_HELPER_USER_PER_5_MINUTES', 20),
      ip: intEnv('RATE_LIMIT_AI_HELPER_IP_PER_5_MINUTES', 80),
    },
    {
      name: 'sustained',
      seconds: HOUR,
      user: intEnv('RATE_LIMIT_AI_HELPER_USER_PER_HOUR', 120),
      ip: intEnv('RATE_LIMIT_AI_HELPER_IP_PER_HOUR', 300),
    },
  ],
  'career-chat': [
    {
      name: 'burst',
      seconds: FIVE_MINUTES,
      user: intEnv('RATE_LIMIT_AI_CAREER_USER_PER_5_MINUTES', 8),
      ip: intEnv('RATE_LIMIT_AI_CAREER_IP_PER_5_MINUTES', 30),
    },
    {
      name: 'sustained',
      seconds: HOUR,
      user: intEnv('RATE_LIMIT_AI_CAREER_USER_PER_HOUR', 40),
      ip: intEnv('RATE_LIMIT_AI_CAREER_IP_PER_HOUR', 100),
    },
  ],
  talk: [
    {
      name: 'burst',
      seconds: FIVE_MINUTES,
      user: intEnv('RATE_LIMIT_AI_TALK_USER_PER_5_MINUTES', 10),
      ip: intEnv('RATE_LIMIT_AI_TALK_IP_PER_5_MINUTES', 40),
    },
    {
      name: 'sustained',
      seconds: HOUR,
      user: intEnv('RATE_LIMIT_AI_TALK_USER_PER_HOUR', 60),
      ip: intEnv('RATE_LIMIT_AI_TALK_IP_PER_HOUR', 140),
    },
  ],
};

class AIRateLimitService {
  private fallbackWarningByScope = new Map<string, number>();

  private maybeLogMemoryFallback(scope: AIRateLimitScope, requestId: string, window: string): void {
    if (!process.env.REDIS_URL) {
      return;
    }

    const now = Date.now();
    const key = `ai-rate:${scope}:${window}`;
    const previous = this.fallbackWarningByScope.get(key) || 0;

    if (now - previous < 60_000) {
      return;
    }

    this.fallbackWarningByScope.set(key, now);
    logger.warn({
      event: 'ai.redis.fallback',
      requestId,
      scope,
      window,
      reason: 'redis_unavailable',
    });
  }

  private async evaluateBucket(params: {
    identifier: string;
    keyType: 'user' | 'ip';
    limit: number;
    requestId: string;
    scope: AIRateLimitScope;
    window: AIRateLimitWindow;
  }): Promise<RateLimitBucketResult> {
    const { identifier, keyType, limit, requestId, scope, window } = params;
    const result = await cacheService.incrementFixedWindow(
      `ai:rate-limit:${scope}:${window.name}:${keyType}:${identifier}`,
      window.seconds
    );

    if (result.backend === 'memory') {
      this.maybeLogMemoryFallback(scope, requestId, window.name);
    }

    return {
      backend: result.backend,
      allowed: result.count <= limit,
      keyType,
      limit,
      remaining: Math.max(limit - result.count, 0),
      resetAt: result.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
      window: window.name,
    };
  }

  async checkLimit(params: AIRateLimitCheckParams): Promise<AIRateLimitCheckResult> {
    const { ip, requestId, scope, userId } = params;
    const windows = SCOPE_LIMITS[scope];
    const bucketChecks = windows.flatMap((window) => {
      const checks: Array<Promise<RateLimitBucketResult>> = [];
      if (userId) {
        checks.push(
          this.evaluateBucket({
            identifier: userId,
            keyType: 'user',
            limit: window.user,
            requestId,
            scope,
            window,
          })
        );
      }

      checks.push(
        this.evaluateBucket({
          identifier: ip,
          keyType: 'ip',
          limit: window.ip,
          requestId,
          scope,
          window,
        })
      );
      return checks;
    });
    const buckets = await Promise.all(bucketChecks);

    const firstBlocked = buckets.find((bucket) => !bucket.allowed);
    const mostConstrained = buckets.reduce((current, candidate) => {
      const currentRatio = current.limit > 0 ? current.remaining / current.limit : 0;
      const candidateRatio = candidate.limit > 0 ? candidate.remaining / candidate.limit : 0;

      if (candidateRatio !== currentRatio) {
        return candidateRatio < currentRatio ? candidate : current;
      }

      return candidate.resetAt < current.resetAt ? candidate : current;
    }, buckets[0]);

    const effective = firstBlocked || mostConstrained;
    const userBucket = buckets.find((bucket) => bucket.keyType === 'user');
    const ipBucket = buckets.find((bucket) => bucket.keyType === 'ip');

    if (firstBlocked) {
      return {
        allowed: false,
        blockedBy: firstBlocked.keyType,
        buckets,
        effective,
        userBucket,
        ipBucket,
      };
    }

    return {
      allowed: true,
      buckets,
      effective,
      userBucket,
      ipBucket,
    };
  }
}

export const aiRateLimitService = new AIRateLimitService();
export type { AIRateLimitScope, AIRateLimitCheckResult };
