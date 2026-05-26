import { Router } from 'express';
import { verifyEmail, resendVerification } from '../controllers/verification.controller';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

const router = Router();
const verifyEmailRateLimit = createRateLimitMiddleware((req) => {
  const token = String(req.query?.token || 'unknown').trim();
  return [
    {
      keyPrefix: 'rate:ip:auth:verify-email',
      limit: 20,
      windowSeconds: 15 * 60,
      code: 'email_verification_rate_limited',
      message: 'Too many email verification attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:token:auth:verify-email',
      limit: 8,
      windowSeconds: 15 * 60,
      identifier: () => hashRateLimitIdentifier(token || 'unknown'),
      code: 'email_verification_rate_limited',
      message: 'Too many email verification attempts for this token. Please wait before trying again.',
    },
  ];
});
const resendVerificationRateLimit = createRateLimitMiddleware((req) => {
  const email = String(req.body?.email || 'unknown').trim().toLowerCase();
  return [
    {
      keyPrefix: 'rate:ip:auth:resend-verification',
      limit: 6,
      windowSeconds: 15 * 60,
      code: 'email_verification_rate_limited',
      message: 'Too many verification email requests. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:identifier:auth:resend-verification',
      limit: 3,
      windowSeconds: 60 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'email_verification_rate_limited',
      message: 'Too many verification email requests for this address. Please try again later.',
    },
  ];
});

/**
 * Email Verification Routes
 * 
 * GET /api/auth/verify-email - Verify email with token
 * POST /api/auth/resend-verification - Resend verification email
 * 
 * Note: These are public endpoints (no authentication required)
 */

// Verify email endpoint
router.get('/verify-email', verifyEmailRateLimit, verifyEmail);

// Resend verification endpoint
router.post('/resend-verification', resendVerificationRateLimit, resendVerification);

export default router;
