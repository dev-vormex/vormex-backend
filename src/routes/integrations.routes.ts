import express from 'express';
import {
  startGitHubOAuth,
  handleGitHubCallback,
  syncGitHubStats,
  disconnectGitHub,
  getGitHubStats,
} from '../controllers/integrations.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

// GitHub OAuth routes
router.get('/github/start', authenticate, startGitHubOAuth);
router.get('/github/callback', handleGitHubCallback); // No auth - public callback
router.post('/github/sync', authenticate, syncGitHubStats);
router.post('/github/disconnect', authenticate, disconnectGitHub);
router.get('/github/stats', authenticate, getGitHubStats);

export default router;

