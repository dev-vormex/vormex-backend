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
      keyPrefix: 'rate:ip:auth:register',
      limit: 6,
      windowSeconds: 15 * 60,
      code: 'account_creation_rate_limited',
      message: 'Too many account creation attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:ip:auth:register:sustained',
      limit: 20,
      windowSeconds: 60 * 60,
      code: 'account_creation_rate_limited',
      message: 'Too many account creation attempts. Please try again later.',
    },
    {
      keyPrefix: 'rate:identifier:auth:register',
      limit: 3,
      windowSeconds: 60 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'account_creation_rate_limited',
      message: 'Too many account creation attempts for this email. Please try again later.',
    },
    {
      keyPrefix: 'rate:identifier:auth:register:day',
      limit: 5,
      windowSeconds: 24 * 60 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'account_creation_rate_limited',
      message: 'Too many account creation attempts for this email. Please try again tomorrow.',
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
      keyPrefix: 'rate:ip:auth:login:burst',
      limit: 5,
      windowSeconds: 5 * 60,
      code: 'login_rate_limited',
      message: 'Too many login attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:ip:auth:login',
      limit: 12,
      windowSeconds: 15 * 60,
      code: 'login_rate_limited',
      message: 'Too many login attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:ip:auth:login:sustained',
      limit: 50,
      windowSeconds: 60 * 60,
      code: 'login_rate_limited',
      message: 'Too many login attempts. Please try again later.',
    },
    {
      keyPrefix: 'rate:identifier:auth:login',
      limit: 5,
      windowSeconds: 15 * 60,
      identifier: () => hashRateLimitIdentifier(identifier || 'unknown'),
      code: 'login_rate_limited',
      message: 'Too many login attempts for this account. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:identifier:auth:login:sustained',
      limit: 12,
      windowSeconds: 60 * 60,
      identifier: () => hashRateLimitIdentifier(identifier || 'unknown'),
      code: 'login_rate_limited',
      message: 'Too many login attempts for this account. Please try again later.',
    },
  ];
});

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

// Get current user endpoint (protected)
router.get('/me', authenticate, getCurrentUser);

export default router;
