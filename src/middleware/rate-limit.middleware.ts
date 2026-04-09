import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import { evaluateRateLimit, type RateLimitRule } from '../services/rate-limit.service';

function setHeaders(res: Response, result: { limit: number; remaining: number; resetAt: number; retryAfterSeconds: number }) {
  res.setHeader('x-ratelimit-limit', String(result.limit));
  res.setHeader('x-ratelimit-remaining', String(result.remaining));
  res.setHeader('x-ratelimit-reset', String(Math.floor(result.resetAt / 1000)));
}

export function createRateLimitMiddleware(
  resolveRules: (req: AuthenticatedRequest) => RateLimitRule[]
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rules = resolveRules(req);

    for (const rule of rules) {
      const identifier = rule.keyPrefix.includes(':user:') && userId ? userId : ip;
      const result = await evaluateRateLimit(identifier, rule);
      setHeaders(res, result);

      if (!result.allowed) {
        res.setHeader('retry-after', String(result.retryAfterSeconds));
        res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfterSeconds: result.retryAfterSeconds,
        });
        return;
      }
    }

    next();
  };
}
