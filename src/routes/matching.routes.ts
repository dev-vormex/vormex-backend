import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getSmartMatches,
  getMentorMatches,
  getAccountabilityMatches,
  getIceBreakers,
} from '../controllers/matching.controller';

const router = Router();

/**
 * Matching Routes (all protected)
 *
 * GET /api/matching/smart - Get smart matches with type filter
 * GET /api/matching/mentors - Get mentor matches
 * GET /api/matching/accountability - Get accountability partner matches
 * GET /api/matching/ice-breakers/:targetUserId - Get ice breakers for a user
 */

router.get('/smart', authenticate, getSmartMatches);
router.get('/mentors', authenticate, getMentorMatches);
router.get('/accountability', authenticate, getAccountabilityMatches);
router.get('/ice-breakers/:targetUserId', authenticate, getIceBreakers);

export default router;
