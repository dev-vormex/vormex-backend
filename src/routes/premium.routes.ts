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

const router = Router();

router.use(authenticate);

router.get('/subscription', getPremiumSubscription);
router.get('/creator-pro', getCreatorProForMe);
router.patch('/creator-pro/settings', updateCreatorProSettingsForMe);
router.get('/boosts/me', getMyProfileBoost);
router.post('/boosts/profile', activateMyProfileBoost);
router.post('/debug-override', setDeveloperPremiumOverrideForMe);
router.post('/creator-pro/debug-override', setDeveloperCreatorProOverrideForMe);
router.post('/checkout', paymentActionRateLimit, createPremiumCheckout);
router.post('/verify', paymentActionRateLimit, verifyPremiumCheckout);
router.post('/play/verify', paymentActionRateLimit, verifyGooglePlayPremiumCheckout);
router.post('/cancel', paymentActionRateLimit, cancelMyPremiumSubscription);

export default router;
