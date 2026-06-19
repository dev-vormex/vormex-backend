import { Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { verifyToken, type JWTPayload } from '../utils/jwt.util';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { getRequestId, getRequestLogger } from '../lib/logger';
import { getAuthSession } from '../services/auth-session.service';
import {
  getCachedAuthUserStatus,
  setCachedAuthUserStatus,
} from '../services/auth-user-status-cache.service';
import {
  ACCESS_TOKEN_COOKIE,
  getCookie,
  getCsrfTokenFromRequest,
  isUnsafeHttpMethod,
  verifyCsrfToken,
} from '../utils/auth-cookie.util';

function requiresSessionBoundAccessTokens(): boolean {
  if (process.env.AUTH_REQUIRE_SESSION_ID === 'true') {
    return true;
  }

  if (process.env.AUTH_REQUIRE_SESSION_ID === 'false') {
    return false;
  }

  const apiRedisMode = (process.env.API_REDIS_MODE || 'auto').toLowerCase();
  if (
    process.env.NODE_ENV !== 'production' &&
    (
      ['0', 'false', 'no', 'disabled'].includes(apiRedisMode) ||
      (!['1', 'true', 'yes', 'enabled'].includes(apiRedisMode) &&
        /upstash\.io/i.test(process.env.REDIS_URL || ''))
    )
  ) {
    return false;
  }

  return process.env.AUTH_REQUIRE_SESSION_ID !== 'false';
}

async function isTokenSessionActive(decoded: JWTPayload): Promise<boolean> {
  if (!requiresSessionBoundAccessTokens()) {
    return true;
  }

  if (!decoded.sessionId) {
    return false;
  }

  const session = await getAuthSession(decoded.sessionId);
  return Boolean(session && session.userId === String(decoded.userId));
}

async function assertUserCanAuthenticate(decoded: JWTPayload): Promise<void> {
  const userId = String(decoded.userId);
  const cachedStatus = await getCachedAuthUserStatus(userId);
  if (cachedStatus === true) {
    return;
  }
  if (cachedStatus === false) {
    throw new Error('User account is disabled or email verification required');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      authProvider: true,
      isBanned: true,
      isVerified: true,
      safetySuspendedUntil: true,
    },
  });

  if (!user) {
    await setCachedAuthUserStatus(userId, false);
    throw new Error('User account no longer exists');
  }

  if (user.isBanned) {
    await setCachedAuthUserStatus(userId, false);
    throw new Error('User account is disabled');
  }

  if (user.safetySuspendedUntil && user.safetySuspendedUntil > new Date()) {
    await setCachedAuthUserStatus(userId, false);
    throw new Error('User account is suspended');
  }

  if (user.authProvider === 'email' && !user.isVerified) {
    await setCachedAuthUserStatus(userId, false);
    throw new Error('Email verification required');
  }

  await setCachedAuthUserStatus(userId, true);
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const decoded = verifyToken(token);
  const sessionActive = await isTokenSessionActive(decoded);
  if (!sessionActive) {
    throw new Error('Session is no longer active');
  }
  await assertUserCanAuthenticate(decoded);
  return decoded;
}

function getAccessTokenFromRequest(req: AuthenticatedRequest): {
  token?: string;
  source: 'authorization' | 'cookie' | 'none';
  invalidAuthorizationHeader?: boolean;
} {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return { source: 'authorization', invalidAuthorizationHeader: true };
    }

    return {
      token: parts[1],
      source: 'authorization',
    };
  }

  const cookieToken = getCookie(req, ACCESS_TOKEN_COOKIE);
  if (cookieToken) {
    return {
      token: cookieToken,
      source: 'cookie',
    };
  }

  return { source: 'none' };
}

function isCookieCsrfValid(req: AuthenticatedRequest, decoded: JWTPayload): boolean {
  if (!isUnsafeHttpMethod(req.method)) {
    return true;
  }

  const csrfToken = getCsrfTokenFromRequest(req);
  return verifyCsrfToken(csrfToken, decoded.sessionId);
}

/**
 * Authentication middleware
 * Verifies JWT token from Authorization header and attaches user to request
 * 
 * Usage:
 * router.get('/protected', authenticate, controller)
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response<ErrorResponse>,
  next: NextFunction
): Promise<void> => {
  const requestId = getRequestId(req);
  const log = getRequestLogger(req);

  try {
    const tokenResult = getAccessTokenFromRequest(req);

    if (tokenResult.invalidAuthorizationHeader) {
      res.status(401).json({
        error: 'Invalid token format. Use "Bearer <token>".',
        code: 'unauthorized',
        requestId,
      });
      return;
    }

    if (!tokenResult.token) {
      res.status(401).json({
        error: 'No authentication token provided.',
        code: 'unauthorized',
        requestId,
      });
      return;
    }

    // Verify token
    try {
      const decoded = await verifyAccessToken(tokenResult.token);

      if (tokenResult.source === 'cookie' && !isCookieCsrfValid(req, decoded)) {
        res.status(403).json({
          error: 'Invalid or missing CSRF token',
          code: 'invalid_csrf',
          requestId,
        });
        return;
      }

      // Attach user info to request
      req.user = {
        userId: decoded.userId,
        sessionId: decoded.sessionId,
      };

      // Continue to next middleware/controller
      next();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Token verification failed';

      if (errorMessage.includes('expired')) {
        res.status(401).json({
          error: 'Token has expired. Please login again.',
          code: 'token_expired',
          requestId,
        });
        return;
      }

      if (errorMessage.includes('suspended')) {
        res.status(403).json({
          error: 'User account is temporarily suspended',
          code: 'account_suspended',
          requestId,
        });
        return;
      }

      if (errorMessage.includes('disabled or email verification required')) {
        res.status(403).json({
          error: 'User account is disabled or email verification is required',
          code: 'auth_not_allowed',
          requestId,
        });
        return;
      }

      if (errorMessage.includes('disabled')) {
        res.status(403).json({
          error: 'User account is disabled',
          code: 'account_disabled',
          requestId,
        });
        return;
      }

      if (errorMessage.includes('verification')) {
        res.status(403).json({
          error: 'Please verify your email before continuing.',
          code: 'email_not_verified',
          requestId,
          requiresVerification: true,
        });
        return;
      }

      res.status(401).json({
        error: 'Invalid or malformed token',
        code: 'unauthorized',
        requestId,
      });
      return;
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({
      event: 'auth.middleware.failure',
      requestId,
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      error: 'Internal server error during authentication',
      code: 'auth_internal_error',
      requestId,
      ...(process.env.NODE_ENV === 'development' && { details: err.message }),
    });
  }
};

/**
 * Optional authentication middleware
 * Attempts to verify JWT token but allows request to continue even if no token
 * Useful for endpoints that need user info if available but don't require auth
 */
export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const tokenResult = getAccessTokenFromRequest(req);

    if (!tokenResult.token || tokenResult.invalidAuthorizationHeader) {
      // No token provided, continue without user
      next();
      return;
    }

    try {
      const decoded = await verifyAccessToken(tokenResult.token);
      if (tokenResult.source === 'cookie' && !isCookieCsrfValid(req, decoded)) {
        next();
        return;
      }

      req.user = {
        userId: decoded.userId,
        sessionId: decoded.sessionId,
      };
    } catch (error) {
      // Token invalid, continue without user
    }

    next();
  } catch (error) {
    console.error('Optional auth middleware error:', error);
    next();
  }
};
