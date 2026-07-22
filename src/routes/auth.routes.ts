import { NextFunction, Request, Response, Router } from 'express';
import {
  register,
  login,
  getCurrentUser,
  refreshSession,
  logout,
  logoutAll,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';
import {
  clearAuthCookies,
  getCookie,
  getCsrfTokenFromRequest,
  REFRESH_TOKEN_COOKIE,
  verifyCsrfToken,
} from '../utils/auth-cookie.util';
import { getRefreshTokenSessionId } from '../services/auth-session.service';
import { generateSocketTicket, getSocketTicketTtlSeconds } from '../utils/jwt.util';
import type { AuthenticatedRequest } from '../types/auth.types';

const router = Router();
const authWriteLimit = createRateLimitMiddleware(() => [
  {
    keyPrefix: 'rate:ip:auth',
    limit: 30,
    windowSeconds: 10 * 60,
    code: 'auth_rate_limited',
    message: 'Too many authentication requests. Please wait before trying again.',
  },
]);
const registerRateLimit = createRateLimitMiddleware((req) => {
  const email = String(req.body?.email || 'unknown').trim().toLowerCase();

  return [
    {
      keyPrefix: 'rate:ip:auth:register:v2',
      limit: 10,
      windowSeconds: 10 * 60,
      code: 'account_creation_rate_limited',
      message: 'Too many account creation attempts.',
    },
    {
      keyPrefix: 'rate:identifier:auth:register:v2',
      limit: 5,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'account_creation_rate_limited',
      message: 'Too many account creation attempts for this email.',
    },
  ];
});
const loginRateLimit = createRateLimitMiddleware((req) => {
  const body = req.body || {};
  const identifier = String(body.emailOrUsername || body.email || body.username || 'unknown')
    .trim()
    .toLowerCase();

  return [
    {
      keyPrefix: 'rate:ip:auth:login:burst:v2',
      limit: 8,
      windowSeconds: 2 * 60,
      code: 'login_rate_limited',
      message: 'Too many login attempts.',
    },
    {
      keyPrefix: 'rate:ip:auth:login:v2',
      limit: 20,
      windowSeconds: 10 * 60,
      code: 'login_rate_limited',
      message: 'Too many login attempts.',
    },
    {
      keyPrefix: 'rate:identifier:auth:login:v2',
      limit: 8,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(identifier || 'unknown'),
      code: 'login_rate_limited',
      message: 'Too many login attempts for this account.',
    },
  ];
});
const socketTicketRateLimit = createRateLimitMiddleware((_req) => [
  {
    keyPrefix: 'rate:user:auth:socket-ticket',
    limit: 60,
    windowSeconds: 60,
    code: 'socket_ticket_rate_limited',
    message: 'Too many realtime connection attempts. Please wait a moment.',
  },
]);

function requireRefreshCookieCsrf(req: Request, res: Response, next: NextFunction): void {
  if (req.body?.refreshToken) {
    next();
    return;
  }

  const refreshToken = getCookie(req, REFRESH_TOKEN_COOKIE);
  if (!refreshToken) {
    next();
    return;
  }

  const sessionId = getRefreshTokenSessionId(refreshToken);
  if (!sessionId || !verifyCsrfToken(getCsrfTokenFromRequest(req), sessionId)) {
    clearAuthCookies(res);
    res.status(403).json({
      error: 'Invalid or missing CSRF token',
      code: 'invalid_csrf',
    });
    return;
  }

  next();
}

/**
 * Authentication Routes
 * 
 * POST /api/auth/register - Register a new user
 * POST /api/auth/login - Login user
 * GET /api/auth/me - Get current authenticated user profile
 */

// Register endpoint
router.post('/register', registerRateLimit, register);

// Login endpoint
router.post('/login', loginRateLimit, login);

router.post('/refresh', authWriteLimit, requireRefreshCookieCsrf, refreshSession);
router.post('/logout', authWriteLimit, requireRefreshCookieCsrf, logout);
router.post('/logout-all', authenticate, logoutAll);

// A short-lived, purpose-bound credential lets the browser authenticate a
// direct Render WebSocket while REST authentication remains on vormex.in/api.
router.post(
  '/socket-ticket',
  authenticate,
  socketTicketRateLimit,
  (req: AuthenticatedRequest, res: Response): void => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication is required', code: 'unauthorized' });
      return;
    }

    const ttlSeconds = getSocketTicketTtlSeconds();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json({
      token: generateSocketTicket(userId, req.user?.sessionId),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }
);

// Get current user endpoint (protected)
router.get('/me', authenticate, getCurrentUser);

export default router;
