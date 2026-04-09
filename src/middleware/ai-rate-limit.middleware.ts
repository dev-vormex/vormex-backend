import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../types/auth.types';
import { getRequestId, getRequestLogger } from '../lib/logger';
import { aiRateLimitService, AIRateLimitScope } from '../services/ai-rate-limit.service';

function setRateLimitHeaders(
  res: Response,
  params: { limit: number; remaining: number; resetAt: number; retryAfterSeconds?: number }
): void {
  res.setHeader('x-ratelimit-limit', String(params.limit));
  res.setHeader('x-ratelimit-remaining', String(params.remaining));
  res.setHeader('x-ratelimit-reset', String(Math.floor(params.resetAt / 1000)));

  if (typeof params.retryAfterSeconds === 'number') {
    res.setHeader('retry-after', String(params.retryAfterSeconds));
  }
}

export function createAIRateLimitMiddleware(scope: AIRateLimitScope) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const requestId = getRequestId(req);
    const log = getRequestLogger(req);
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userId = req.user?.userId ? String(req.user.userId) : undefined;

    const result = await aiRateLimitService.checkLimit({
      ip,
      requestId,
      scope,
      userId,
    });

    setRateLimitHeaders(res, {
      limit: result.effective.limit,
      remaining: result.effective.remaining,
      resetAt: result.effective.resetAt,
      retryAfterSeconds: result.allowed ? undefined : result.effective.retryAfterSeconds,
    });

    if (!result.allowed) {
      log.warn({
        event: 'ai.rate_limit.hit',
        requestId,
        scope,
        blockedBy: result.blockedBy,
        userId,
        ip,
        retryAfterSeconds: result.effective.retryAfterSeconds,
      });

      res.status(429).json({
        error: 'AI requests are cooling down. Please wait a bit before trying again.',
        code: 'ai_rate_limited',
        requestId,
        retryAfterSeconds: result.effective.retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
