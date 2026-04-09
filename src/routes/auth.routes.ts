import { Router } from 'express';
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

const router = Router();
const authWriteLimit = createRateLimitMiddleware(() => [
  {
    keyPrefix: 'rate:ip:auth',
    limit: 5,
    windowSeconds: 10 * 60,
  },
]);

/**
 * Authentication Routes
 * 
 * POST /api/auth/register - Register a new user
 * POST /api/auth/login - Login user
 * GET /api/auth/me - Get current authenticated user profile
 */

// Register endpoint
router.post('/register', authWriteLimit, register);

// Login endpoint
router.post('/login', authWriteLimit, login);

router.post('/refresh', authWriteLimit, refreshSession);
router.post('/logout', authWriteLimit, logout);
router.post('/logout-all', authenticate, logoutAll);

// Get current user endpoint (protected)
router.get('/me', authenticate, getCurrentUser);

export default router;
