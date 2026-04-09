import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getAllBadges,
  getUserBadges,
  getMyBadges,
  getBadgeCategories,
  getBadgeProgress,
  checkForBadges,
  getUnnotifiedBadges,
  getBadgeLeaderboard,
} from '../controllers/badges.controller';

const router = Router();

// Public routes
router.get('/', getAllBadges);
router.get('/categories', getBadgeCategories);
router.get('/user/:userId', getUserBadges);

// Protected routes
router.use(authenticate);

router.get('/me', getMyBadges);
router.get('/progress', getBadgeProgress);
router.post('/check', checkForBadges);
router.get('/unnotified', getUnnotifiedBadges);
router.get('/leaderboard', getBadgeLeaderboard);

export default router;
