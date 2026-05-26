import { Router } from 'express';
import { forgotPassword, resetPassword } from '../controllers/password.controller';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

const router = Router();
const forgotPasswordRateLimit = createRateLimitMiddleware((req) => {
  const email = String(req.body?.email || 'unknown').trim().toLowerCase();
  return [
    {
      keyPrefix: 'rate:ip:auth:forgot-password',
      limit: 6,
      windowSeconds: 15 * 60,
      code: 'password_reset_rate_limited',
      message: 'Too many password reset requests. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:identifier:auth:forgot-password',
      limit: 3,
      windowSeconds: 60 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'password_reset_rate_limited',
      message: 'Too many password reset requests for this email. Please try again later.',
    },
  ];
});
const resetPasswordRateLimit = createRateLimitMiddleware((req) => {
  const token = String(req.body?.token || req.query?.token || 'unknown').trim();
  return [
    {
      keyPrefix: 'rate:ip:auth:reset-password',
      limit: 12,
      windowSeconds: 15 * 60,
      code: 'password_reset_rate_limited',
      message: 'Too many password reset attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:token:auth:reset-password',
      limit: 6,
      windowSeconds: 15 * 60,
      identifier: () => hashRateLimitIdentifier(token || 'unknown'),
      code: 'password_reset_rate_limited',
      message: 'Too many password reset attempts for this token. Please wait before trying again.',
    },
  ];
});

/**
 * Password Reset Routes
 * 
 * POST /api/auth/forgot-password - Request password reset email
 * POST /api/auth/reset-password - Reset password with token
 * 
 * Note: These are public endpoints (no authentication required)
 */

// Forgot password endpoint
router.post('/forgot-password', forgotPasswordRateLimit, forgotPassword);

// Reset password endpoint
router.post('/reset-password', resetPasswordRateLimit, resetPassword);

export default router;
