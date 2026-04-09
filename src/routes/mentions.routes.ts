import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  searchMentions,
  createMentions,
  getPendingMentions,
  getMyMentions,
  respondToMention,
  toggleShowOnProfile,
  getProfileMentions,
  getMentionCount,
} from '../controllers/mentions.controller';

const router = Router();

/**
 * Mentions Routes
 * 
 * GET /api/mentions/search?q=query - Search users for @mention autocomplete (protected)
 * POST /api/mentions - Create mentions for a post (protected)
 * GET /api/mentions/pending - Get pending mentions for notifications (protected)
 * GET /api/mentions - Get all mentions for the current user (protected)
 * GET /api/mentions/count - Get pending mention count for badge (protected)
 * POST /api/mentions/:mentionId/respond - Accept or reject a mention (protected)
 * PATCH /api/mentions/:mentionId/profile - Toggle show on profile (protected)
 * GET /api/mentions/profile/:userId - Get posts on a user's profile from mentions (public)
 */

// All routes require authentication except profile mentions
router.use(authenticate);

// Search for @mention autocomplete
router.get('/search', searchMentions);

// Create mentions
router.post('/', createMentions);

// Get pending mentions (notifications)
router.get('/pending', getPendingMentions);

// Get mention count for badge
router.get('/count', getMentionCount);

// Get profile mentions (public - remove auth for this route only)
router.get('/profile/:userId', getProfileMentions);

// Get all mentions
router.get('/', getMyMentions);

// Respond to a mention (accept/reject)
router.post('/:mentionId/respond', respondToMention);

// Toggle show on profile
router.patch('/:mentionId/profile', toggleShowOnProfile);

export default router;
