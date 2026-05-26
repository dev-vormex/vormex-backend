import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import { getRequestId, getRequestLogger } from '../lib/logger';
import { createRateLimitMiddleware } from './rate-limit.middleware';
import {
  isHighConfidenceScannerUserAgent,
  resolveGeneralApiRateLimitRules,
  resolveSensitiveActionRateLimitRules,
} from '../services/abuse-protection.service';

export function botGuard(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const userAgent = String(req.headers['user-agent'] || '');

  if (!isHighConfidenceScannerUserAgent(userAgent)) {
    next();
    return;
  }

  const requestId = getRequestId(req);
  getRequestLogger(req).warn({
    event: 'bot_guard.blocked',
    requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip || req.socket.remoteAddress || 'unknown',
    userAgent,
  });

  res.status(403).json({
    error: 'Automated scanning traffic is not allowed.',
    code: 'automated_client_blocked',
    requestId,
  });
}

export const generalApiRateLimit = createRateLimitMiddleware(resolveGeneralApiRateLimitRules);

export const paymentActionRateLimit = createRateLimitMiddleware((req) =>
  resolveSensitiveActionRateLimitRules(req, 'payment')
);
