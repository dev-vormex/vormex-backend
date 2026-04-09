import express from 'express';
import {
  getProfile,
  getProfileFeed,
  updateProfile,
  uploadBanner,
  uploadAvatar,
  getUserActivity,
  getUserActivityYears,
} from '../controllers/profile.controller';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * Profile Routes
 * 
 * GET /api/users/:userId/profile - Get full user profile (supports UUID, username, or "me", public, respects privacy)
 * GET /api/users/:userId/feed - Get user's content feed (supports UUID or username, public)
 * GET /api/users/:userId/activity - Get activity heatmap (supports UUID or username, public)
 * GET /api/users/:userId/activity/years - Get available years (supports UUID or username, public)
 * PUT /api/users/me - Update own profile (protected, username cannot be changed)
 * POST /api/users/me/banner - Upload banner image (protected)
 * POST /api/users/me/avatar - Upload avatar image (protected)
 */

// Public routes (support both UUID and username; optionalAuth for "me" resolution)
router.get('/users/:userId/profile', optionalAuth, getProfile); // Public but respects privacy settings
router.get('/users/:userId/feed', getProfileFeed); // Public
router.get('/users/:userId/activity', getUserActivity); // Public - GitHub-style contribution calendar
router.get('/users/:userId/activity/years', getUserActivityYears); // Public - Available years for dropdown

// Protected routes
router.put('/users/me', authenticate, updateProfile);
router.post('/users/me/banner', authenticate, uploadBanner);
router.post('/users/me/avatar', authenticate, uploadAvatar);

export default router;

