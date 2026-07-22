import { Router } from 'express';
import { forgotPassword, resetPassword } from '../controllers/password.controller';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

const router = Router();
const forgotPasswordRateLimit = createRateLimitMiddleware((req) => {
  const email = String(req.body?.email || 'unknown').trim().toLowerCase();
  return [
    {
      keyPrefix: 'rate:ip:auth:forgot-password:v2',
      limit: 8,
      windowSeconds: 10 * 60,
      code: 'password_reset_rate_limited',
      message: 'Too many password reset requests.',
    },
    {
      keyPrefix: 'rate:identifier:auth:forgot-password:v2',
      limit: 4,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'password_reset_rate_limited',
      message: 'Too many password reset requests for this email.',
    },
  ];
});
const resetPasswordRateLimit = createRateLimitMiddleware((req) => {
  const token = String(req.body?.token || req.query?.token || 'unknown').trim();
  return [
    {
      keyPrefix: 'rate:ip:auth:reset-password:v2',
      limit: 12,
      windowSeconds: 10 * 60,
      code: 'password_reset_rate_limited',
      message: 'Too many password reset attempts.',
    },
    {
      keyPrefix: 'rate:token:auth:reset-password:v2',
      limit: 6,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(token || 'unknown'),
      code: 'password_reset_rate_limited',
      message: 'Too many password reset attempts for this token.',
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
