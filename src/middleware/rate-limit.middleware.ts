import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import {
  evaluateEmergencyRateLimit,
  evaluateRateLimit,
  type RateLimitResult,
  type RateLimitRule,
} from '../services/rate-limit.service';
import { getRequestId, getRequestLogger } from '../lib/logger';
import { emergencyRateLimitCounter } from '../infrastructure/metrics/registry';

interface RateLimitMiddlewareOptions {
  evaluate?: (identifier: string, rule: RateLimitRule) => Promise<RateLimitResult>;
}

const SENSITIVE_KEY_PATTERN = /(^|:)(auth|login|register|verification|password|oauth|payment|premium|message|chat|media|upload|ai|search|matching)(:|$)/i;
const SENSITIVE_PATH_PATTERNS = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/oauth(?:\/|$)/,
  /^\/api\/password(?:\/|$)/,
  /^\/api\/verification(?:\/|$)/,
  /^\/api\/premium(?:\/|$)/,
  /^\/api\/payments?(?:\/|$)/,
  /^\/api\/chat(?:\/|$)/,
  /^\/api\/messages?(?:\/|$)/,
  /^\/api\/conversations?(?:\/|$)/,
  /^\/api\/uploads?(?:\/|$)/,
  /^\/api\/ai(?:\/|$)/,
  /^\/api\/agent(?:\/|$)/,
  /^\/api\/search(?:\/|$)/,
  /^\/api\/people(?:\/|$)/,
  /^\/api\/matching(?:\/|$)/,
  /^\/api\/mentions\/search(?:\/|$)/,
];

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

function normalizedPath(req: AuthenticatedRequest): string {
  const rawPath = (req.originalUrl || req.url || '').split('?')[0] || '/';
  return rawPath.replace(/\/+$/, '') || '/';
}

function isSensitiveRateLimit(req: AuthenticatedRequest, rule: RateLimitRule): boolean {
  if (SENSITIVE_KEY_PATTERN.test(rule.keyPrefix)) {
    return true;
  }

  const path = normalizedPath(req);
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function metricKeyPrefix(keyPrefix: string): string {
  return keyPrefix.replace(/[^a-z0-9:_-]/gi, '_').slice(0, 96) || 'unknown';
}

export function createRateLimitMiddleware(
  resolveRules: (req: AuthenticatedRequest) => RateLimitRule[],
  options: RateLimitMiddlewareOptions = {}
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const requestId = getRequestId(req);
      const log = getRequestLogger(req);
      const userId = req.user?.userId ? String(req.user.userId) : null;
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rules = resolveRules(req);
      const evaluate = options.evaluate || evaluateRateLimit;
      let effective: RateLimitResult | null = null;

      for (const rule of rules) {
        const customIdentifier = rule.identifier?.(req);
        const identifier = customIdentifier || (rule.keyPrefix.includes(':user:') && userId ? userId : ip);
        let result: RateLimitResult;
        try {
          result = await evaluate(identifier, rule);
        } catch (error) {
          if (isSensitiveRateLimit(req, rule)) {
            result = evaluateEmergencyRateLimit(identifier, rule);
            emergencyRateLimitCounter.inc({
              action: result.allowed ? 'allowed' : 'blocked',
              key_prefix: metricKeyPrefix(rule.keyPrefix),
            });
            log.warn({
              event: 'rate_limit.emergency',
              requestId,
              path: req.originalUrl,
              method: req.method,
              keyPrefix: rule.keyPrefix,
              userId,
              ip,
              backend: result.backend,
              allowed: result.allowed,
              limit: result.limit,
              retryAfterSeconds: result.retryAfterSeconds,
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
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
