import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  cancelMyPremiumSubscription,
  createPremiumCheckout,
  getPremiumSubscription,
  setDeveloperPremiumOverrideForMe,
  verifyGooglePlayPremiumCheckout,
  verifyPremiumCheckout,
} from '../controllers/premium.controller';
import { paymentActionRateLimit } from '../middleware/abuse-protection.middleware';

const router = Router();

router.use(authenticate);

router.get('/subscription', getPremiumSubscription);
router.post('/debug-override', setDeveloperPremiumOverrideForMe);
router.post('/checkout', paymentActionRateLimit, createPremiumCheckout);
router.post('/verify', paymentActionRateLimit, verifyPremiumCheckout);
router.post('/play/verify', paymentActionRateLimit, verifyGooglePlayPremiumCheckout);
router.post('/cancel', paymentActionRateLimit, cancelMyPremiumSubscription);

export default router;
