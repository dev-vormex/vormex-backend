import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getRewardData,
  markRewardShown,
} from '../controllers/feed.controller';

const router = Router();

// All feed routes require authentication
router.use(authenticate);

// Variable rewards
router.get('/reward-data', getRewardData);
router.post('/mark-shown', markRewardShown);

export default router;
