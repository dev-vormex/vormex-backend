import { Router } from 'express';
import { forgotPassword, resetPassword } from '../controllers/password.controller';

const router = Router();

/**
 * Password Reset Routes
 * 
 * POST /api/auth/forgot-password - Request password reset email
 * POST /api/auth/reset-password - Reset password with token
 * 
 * Note: These are public endpoints (no authentication required)
 */

// Forgot password endpoint
router.post('/forgot-password', forgotPassword);

// Reset password endpoint
router.post('/reset-password', resetPassword);

export default router;

