import { Router } from 'express';
import { googleCodeSignIn, googleSignIn } from '../controllers/oauth.controller';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { hashRateLimitIdentifier } from '../utils/auth-security.util';

const router = Router();

const googleSignInRateLimit = createRateLimitMiddleware((req) => {
  const idToken = String(req.body?.idToken || 'unknown');

  return [
    {
      keyPrefix: 'rate:ip:auth:google',
      limit: 12,
      windowSeconds: 15 * 60,
      code: 'oauth_rate_limited',
      message: 'Too many Google sign-in attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:ip:auth:google:sustained',
      limit: 40,
      windowSeconds: 60 * 60,
      code: 'oauth_rate_limited',
      message: 'Too many Google sign-in attempts. Please try again later.',
    },
    {
      keyPrefix: 'rate:token:auth:google',
      limit: 6,
      windowSeconds: 15 * 60,
      identifier: () => hashRateLimitIdentifier(idToken.slice(0, 256) || 'unknown'),
      code: 'oauth_rate_limited',
      message: 'Too many Google sign-in attempts for this token. Please wait before trying again.',
    },
  ];
});

const googleCodeSignInRateLimit = createRateLimitMiddleware((req) => {
  const code = String(req.body?.code || 'unknown');

  return [
    {
      keyPrefix: 'rate:ip:auth:google-code',
      limit: 10,
      windowSeconds: 15 * 60,
      code: 'oauth_rate_limited',
      message: 'Too many Google sign-in attempts. Please wait before trying again.',
    },
    {
      keyPrefix: 'rate:ip:auth:google-code:sustained',
      limit: 30,
      windowSeconds: 60 * 60,
      code: 'oauth_rate_limited',
      message: 'Too many Google sign-in attempts. Please try again later.',
    },
    {
      keyPrefix: 'rate:code:auth:google-code',
      limit: 3,
      windowSeconds: 15 * 60,
      identifier: () => hashRateLimitIdentifier(code.slice(0, 256) || 'unknown'),
      code: 'oauth_rate_limited',
      message: 'Too many Google sign-in attempts for this authorization code. Please wait before trying again.',
    },
  ];
});

/**
 * OAuth Routes
 * 
 * POST /api/auth/google - Google Sign-In authentication
 * 
 * Note: This is a public endpoint (no authentication required)
 * The Google ID token is verified with Google's servers before processing
 */

// Google Sign-In endpoints
router.post('/google', googleSignInRateLimit, googleSignIn);
router.post('/google/code', googleCodeSignInRateLimit, googleCodeSignIn);

export default router;
