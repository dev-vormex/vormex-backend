import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import {
  getPreferences,
  ingestEvents,
  patchPreferences,
  submitFeedback,
} from '../controllers/recommendation.controller';

const router = Router();

router.use(authenticate);
router.post('/events', createRateLimitMiddleware(() => [{
  keyPrefix: 'rate:user:recommendation-events',
  limit: 120,
  windowSeconds: 60,
}]), ingestEvents);
router.post('/feedback', submitFeedback);
router.get('/preferences', getPreferences);
router.patch('/preferences', patchPreferences);

export default router;
