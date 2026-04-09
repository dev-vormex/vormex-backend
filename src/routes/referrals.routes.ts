import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getMyReferralCode,
  applyReferralCode,
  getReferralStats,
  getReferralsList,
  getReferralLeaderboard,
  getShareLinks,
} from '../controllers/referrals.controller';

const router = Router();

router.use(authenticate);

router.get('/code', getMyReferralCode);
router.post('/apply', applyReferralCode);
router.get('/stats', getReferralStats);
router.get('/list', getReferralsList);
router.get('/leaderboard', getReferralLeaderboard);
router.get('/share', getShareLinks);

export default router;
