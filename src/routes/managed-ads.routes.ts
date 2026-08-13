import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getSidebarManagedAd,
  trackManagedAdClick,
  trackManagedAdImpression,
} from '../controllers/managed-ads.controller';

const router = Router();

router.use(authenticate);

// Declared before the :campaignId routes so the literal segment wins.
router.get('/sidebar', getSidebarManagedAd);

router.post('/:campaignId/impression', trackManagedAdImpression);
router.post('/:campaignId/click', trackManagedAdClick);

export default router;
