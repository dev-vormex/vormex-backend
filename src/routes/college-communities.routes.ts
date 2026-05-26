import { Router, RequestHandler } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  createCollegeCommunity,
  getMyCollegeVerification,
  joinCollegeCommunity,
  listCollegeCommunities,
  verifyCollegeStudent,
} from '../controllers/college-communities.controller';

const router = Router();

router.get('/', optionalAuth, listCollegeCommunities as RequestHandler);
router.get('/me/verification', authenticate, getMyCollegeVerification as RequestHandler);
router.post('/', authenticate, createCollegeCommunity as RequestHandler);
router.post('/verify', authenticate, verifyCollegeStudent as RequestHandler);
router.post('/:communityId/join', authenticate, joinCollegeCommunity as RequestHandler);

export default router;
