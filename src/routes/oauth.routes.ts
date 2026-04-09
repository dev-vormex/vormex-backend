import { Router } from 'express';
import { googleSignIn } from '../controllers/oauth.controller';

const router = Router();

/**
 * OAuth Routes
 * 
 * POST /api/auth/google - Google Sign-In authentication
 * 
 * Note: This is a public endpoint (no authentication required)
 * The Google ID token is verified with Google's servers before processing
 */

// Google Sign-In endpoint
router.post('/google', googleSignIn);

export default router;

