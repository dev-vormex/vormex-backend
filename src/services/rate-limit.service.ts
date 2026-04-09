import { cacheService } from './cache.service';

export interface RateLimitRule {
  keyPrefix: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export async function evaluateRateLimit(
  identifier: string,
  rule: RateLimitRule
): Promise<RateLimitResult> {
  const result = await cacheService.incrementFixedWindow(
    `${rule.keyPrefix}:${identifier}`,
    rule.windowSeconds
  );

  return {
    allowed: result.count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - result.count),
    resetAt: result.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
  };
}
