import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import { getRequestId, getRequestLogger } from '../lib/logger';
import { cacheService } from '../services/cache.service';
import { getFirebaseAppCheck } from '../services/firebase-admin.service';
import { getNormalizedApiPath, isSensitiveApiPath } from '../services/abuse-protection.service';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

type AppCheckMode = 'off' | 'monitor' | 'sensitive' | 'all';

interface CachedAppCheckVerification {
  appId?: string;
  expireTimeMillis?: number;
  status: 'valid' | 'invalid';
}

const APP_CHECK_HEADER = 'x-firebase-appcheck';

function getMode(): AppCheckMode {
  const configured = String(process.env.APP_CHECK_ENFORCEMENT || process.env.ABUSE_APP_CHECK_MODE || 'monitor')
    .trim()
    .toLowerCase();

  if (configured === 'off' || configured === 'monitor' || configured === 'sensitive' || configured === 'all') {
    return configured;
  }

  if (configured === 'true' || configured === 'enforce') {
    return 'sensitive';
  }

  return 'monitor';
}

function requiresAppCheck(req: AuthenticatedRequest): boolean {
  const mode = getMode();
  if (mode === 'off' || mode === 'monitor') {
    return false;
  }

  if (mode === 'all') {
    return true;
  }

  return isSensitiveApiPath(getNormalizedApiPath(req));
}

function getToken(req: AuthenticatedRequest): string | null {
  const raw = req.headers[APP_CHECK_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function verificationTtlSeconds(expireTimeMillis?: number): number {
  if (!expireTimeMillis) {
    return 300;
  }

  const secondsUntilExpiry = Math.floor((expireTimeMillis - Date.now()) / 1000);
  return Math.max(30, Math.min(300, secondsUntilExpiry - 30));
}

export async function optionalAppCheck(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    next();
    return;
  }

  const required = requiresAppCheck(req);
  const requestId = getRequestId(req);
  const log = getRequestLogger(req);
  const token = getToken(req);

  if (!token) {
    req.appCheck = { status: 'missing' };
    if (required) {
      res.status(403).json({
        error: 'Valid app attestation is required for this endpoint.',
        code: 'app_check_required',
        requestId,
      });
      return;
    }
    next();
    return;
  }

  const tokenHash = hashRateLimitIdentifier(token);
  const cacheKey = `app-check:${tokenHash}`;

  try {
    const cached = await cacheService.get<CachedAppCheckVerification>(cacheKey);
    if (cached) {
      req.appCheck = {
        status: cached.status,
        appId: cached.appId,
        expireTimeMillis: cached.expireTimeMillis,
      };

      if (required && cached.status !== 'valid') {
        res.status(403).json({
          error: 'Valid app attestation is required for this endpoint.',
          code: 'app_check_invalid',
          requestId,
        });
        return;
      }

      next();
      return;
    }

    const appCheck = getFirebaseAppCheck();
    if (!appCheck) {
      req.appCheck = { status: 'unconfigured' };
      if (required) {
        res.status(503).json({
          error: 'App attestation verification is temporarily unavailable.',
          code: 'app_check_unavailable',
          requestId,
        });
        return;
      }

      next();
      return;
    }

    const verification = await appCheck.verifyToken(token);
    const appId = verification.token.app_id;
    const expireTimeMillis =
      typeof verification.token.exp === 'number' ? verification.token.exp * 1000 : undefined;

    await cacheService.set<CachedAppCheckVerification>(
      cacheKey,
      {
        status: 'valid',
        appId,
        expireTimeMillis,
      },
      verificationTtlSeconds(expireTimeMillis)
    );

    req.appCheck = {
      status: 'valid',
      appId,
      expireTimeMillis,
    };
    next();
  } catch (error) {
    await cacheService.set<CachedAppCheckVerification>(
      cacheKey,
      {
        status: 'invalid',
      },
      60
    );

    req.appCheck = { status: 'invalid' };
    log.warn({
      event: 'app_check.invalid',
      requestId,
      path: req.originalUrl,
      mode,
      required,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });

    if (required) {
      res.status(403).json({
        error: 'Valid app attestation is required for this endpoint.',
        code: 'app_check_invalid',
        requestId,
      });
      return;
    }

    next();
  }
}
