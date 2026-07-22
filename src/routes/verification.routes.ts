import { Router } from 'express';
import { verifyEmail, verifyEmailOtpCode, resendVerification } from '../controllers/verification.controller';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

const router = Router();
const verifyEmailRateLimit = createRateLimitMiddleware((req) => {
  const token = String(req.query?.token || 'unknown').trim();
  return [
    {
      keyPrefix: 'rate:ip:auth:verify-email:v2',
      limit: 20,
      windowSeconds: 10 * 60,
      code: 'email_verification_rate_limited',
      message: 'Too many email verification attempts.',
    },
    {
      keyPrefix: 'rate:token:auth:verify-email:v2',
      limit: 8,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(token || 'unknown'),
      code: 'email_verification_rate_limited',
      message: 'Too many email verification attempts for this token.',
    },
  ];
});
const verifyEmailOtpRateLimit = createRateLimitMiddleware((req) => {
  const email = String(req.body?.email || 'unknown').trim().toLowerCase();
  const code = String(req.body?.code || 'unknown').trim();
  return [
    {
      keyPrefix: 'rate:ip:auth:verify-email-otp:v2',
      limit: 15,
      windowSeconds: 10 * 60,
      code: 'email_verification_rate_limited',
      message: 'Too many email verification attempts.',
    },
    {
      keyPrefix: 'rate:identifier:auth:verify-email-otp:v2',
      limit: 8,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'email_verification_rate_limited',
      message: 'Too many verification attempts for this email.',
    },
    {
      keyPrefix: 'rate:code:auth:verify-email-otp:v2',
      limit: 8,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(`${email}:${code}`),
      code: 'email_verification_rate_limited',
      message: 'Too many verification attempts for this code.',
    },
  ];
});
const resendVerificationRateLimit = createRateLimitMiddleware((req) => {
  const email = String(req.body?.email || 'unknown').trim().toLowerCase();
  return [
    {
      keyPrefix: 'rate:ip:auth:resend-verification:v2',
      limit: 8,
      windowSeconds: 10 * 60,
      code: 'email_verification_rate_limited',
      message: 'Too many verification email requests.',
    },
    {
      keyPrefix: 'rate:identifier:auth:resend-verification:v2',
      limit: 4,
      windowSeconds: 10 * 60,
      identifier: () => hashRateLimitIdentifier(email || 'unknown'),
      code: 'email_verification_rate_limited',
      message: 'Too many verification email requests for this address.',
    },
  ];
});

/**
 * Email Verification Routes
 * 
 * GET /api/auth/verify-email - Verify email with legacy token
 * POST /api/auth/verify-email - Verify email with OTP
 * POST /api/auth/resend-verification - Resend verification email
 * 
 * Note: These are public endpoints (no authentication required)
 */

// Verify email endpoint
router.get('/verify-email', verifyEmailRateLimit, verifyEmail);
router.post('/verify-email', verifyEmailOtpRateLimit, verifyEmailOtpCode);

// Resend verification endpoint
router.post('/resend-verification', resendVerificationRateLimit, resendVerification);

export default router;
