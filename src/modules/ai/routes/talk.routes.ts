import { Router } from 'express';
import { getTalkProfilePreview, runTalkTurn } from '../controllers/talk.controller';
import { createAIRateLimitMiddleware } from '../../../shared/middleware/ai-rate-limit.middleware';
import { authenticate } from '../../../shared/middleware/auth.middleware';

const router = Router();
const talkRateLimit = createAIRateLimitMiddleware('talk');

router.use(authenticate);
router.post('/turn', talkRateLimit, runTalkTurn);
router.get('/profile-preview/:userId', getTalkProfilePreview);

export default router;
