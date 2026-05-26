import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import {
  evaluateRateLimit,
  type RateLimitResult,
  type RateLimitRule,
} from '../services/rate-limit.service';
import { getRequestId, getRequestLogger } from '../lib/logger';

function setHeaders(res: Response, result: Pick<RateLimitResult, 'limit' | 'remaining' | 'resetAt'>) {
  res.setHeader('x-ratelimit-limit', String(result.limit));
  res.setHeader('x-ratelimit-remaining', String(result.remaining));
  res.setHeader('x-ratelimit-reset', String(Math.floor(result.resetAt / 1000)));
}

function isMoreConstrained(current: RateLimitResult | null, next: RateLimitResult): boolean {
  if (!current) {
    return true;
  }

  if (!next.allowed && current.allowed) {
    return true;
  }

  const currentRatio = current.limit > 0 ? current.remaining / current.limit : 0;
  const nextRatio = next.limit > 0 ? next.remaining / next.limit : 0;

  if (nextRatio !== currentRatio) {
    return nextRatio < currentRatio;
  }

  return next.resetAt < current.resetAt;
}

export function createRateLimitMiddleware(
  resolveRules: (req: AuthenticatedRequest) => RateLimitRule[]
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const requestId = getRequestId(req);
      const log = getRequestLogger(req);
      const userId = req.user?.userId ? String(req.user.userId) : null;
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rules = resolveRules(req);
      let effective: RateLimitResult | null = null;

      for (const rule of rules) {
        const customIdentifier = rule.identifier?.(req);
        const identifier = customIdentifier || (rule.keyPrefix.includes(':user:') && userId ? userId : ip);
        let result: RateLimitResult;
        try {
          result = await evaluateRateLimit(identifier, rule);
        } catch (error) {
          log.warn({
            event: 'rate_limit.fail_open',
            requestId,
            path: req.originalUrl,
            method: req.method,
            keyPrefix: rule.keyPrefix,
            userId,
            ip,
            error: error instanceof Error ? error.message : String(error),
          });
          next();
          return;
        }

        if (isMoreConstrained(effective, result)) {
          effective = result;
          setHeaders(res, result);
        }

        if (!result.allowed) {
          res.setHeader('retry-after', String(result.retryAfterSeconds));
          log.warn({
            event: 'rate_limit.hit',
            requestId,
            path: req.originalUrl,
            method: req.method,
            keyPrefix: rule.keyPrefix,
            code: rule.code || 'rate_limited',
            userId,
            ip,
            backend: result.backend,
            limit: result.limit,
            retryAfterSeconds: result.retryAfterSeconds,
          });
          res.status(429).json({
            error: rule.message || 'Rate limit exceeded',
            code: rule.code || 'rate_limited',
            requestId,
            retryAfterSeconds: result.retryAfterSeconds,
          });
          return;
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
