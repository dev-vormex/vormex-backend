import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getOnboarding,
  updateStep,
  completeOnboarding,
  getOnboardingMatches,
} from '../controllers/onboarding.controller';

const router = Router();

router.get('/', authenticate, getOnboarding);
router.post('/step', authenticate, updateStep);
router.post('/complete', authenticate, completeOnboarding);
router.get('/matches', authenticate, getOnboardingMatches);

export default router;
