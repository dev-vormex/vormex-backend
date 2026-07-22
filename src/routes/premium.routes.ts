import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  activateMyProfileBoost,
  cancelMyPremiumSubscription,
  createPremiumCheckout,
  getCreatorProForMe,
  getMyProfileBoost,
  getPremiumSubscription,
  setDeveloperCreatorProOverrideForMe,
  setDeveloperPremiumOverrideForMe,
  updateCreatorProSettingsForMe,
  verifyGooglePlayPremiumCheckout,
  verifyPremiumCheckout,
} from '../controllers/premium.controller';
import { paymentActionRateLimit } from '../middleware/abuse-protection.middleware';
import {
  cancelMyPostBoost,
  createMyPostBoost,
  getMyPostBoost,
  getMyPostBoostCredits,
  listMyPostBoosts,
} from '../controllers/premium-post-boost.controller';

const router = Router();

router.use(authenticate);

router.get('/subscription', getPremiumSubscription);
router.get('/creator-pro', getCreatorProForMe);
router.patch('/creator-pro/settings', updateCreatorProSettingsForMe);
router.get('/boosts/me', getMyProfileBoost);
router.post('/boosts/profile', activateMyProfileBoost);
router.get('/post-boosts/credits', getMyPostBoostCredits);
router.get('/post-boosts', listMyPostBoosts);
router.post('/post-boosts', paymentActionRateLimit, createMyPostBoost);
router.get('/post-boosts/:campaignId', getMyPostBoost);
router.post('/post-boosts/:campaignId/cancel', paymentActionRateLimit, cancelMyPostBoost);
router.post('/debug-override', setDeveloperPremiumOverrideForMe);
router.post('/creator-pro/debug-override', setDeveloperCreatorProOverrideForMe);
router.post('/checkout', paymentActionRateLimit, createPremiumCheckout);
router.post('/verify', paymentActionRateLimit, verifyPremiumCheckout);
router.post('/play/verify', paymentActionRateLimit, verifyGooglePlayPremiumCheckout);
router.post('/cancel', paymentActionRateLimit, cancelMyPremiumSubscription);

export default router;
