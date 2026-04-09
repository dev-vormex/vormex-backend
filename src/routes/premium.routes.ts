import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  cancelMyPremiumSubscription,
  createPremiumCheckout,
  getPremiumSubscription,
  verifyPremiumCheckout,
} from '../controllers/premium.controller';

const router = Router();

router.use(authenticate);

router.get('/subscription', getPremiumSubscription);
router.post('/checkout', createPremiumCheckout);
router.post('/verify', verifyPremiumCheckout);
router.post('/cancel', cancelMyPremiumSubscription);

export default router;
