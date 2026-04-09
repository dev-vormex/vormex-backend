import { Router } from 'express';
import { verifyEmail, resendVerification } from '../controllers/verification.controller';

const router = Router();

/**
 * Email Verification Routes
 * 
 * GET /api/auth/verify-email - Verify email with token
 * POST /api/auth/resend-verification - Resend verification email
 * 
 * Note: These are public endpoints (no authentication required)
 */

// Verify email endpoint
router.get('/verify-email', verifyEmail);

// Resend verification endpoint
router.post('/resend-verification', resendVerification);

export default router;

