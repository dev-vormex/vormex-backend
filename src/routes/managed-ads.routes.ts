import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  trackManagedAdClick,
  trackManagedAdImpression,
} from '../controllers/managed-ads.controller';

const router = Router();

router.use(authenticate);

router.post('/:campaignId/impression', trackManagedAdImpression);
router.post('/:campaignId/click', trackManagedAdClick);

export default router;
