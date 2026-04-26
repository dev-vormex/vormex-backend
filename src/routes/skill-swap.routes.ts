import { Router, RequestHandler } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  completeSkillSwapSession,
  createSkillSwapRequest,
  getSkillSwapState,
  getSkillSwapSuggestions,
  respondToSkillSwapRequest,
} from '../controllers/skills.controller';

const router = Router();

router.use(authenticate);

router.get('/suggestions', getSkillSwapSuggestions as RequestHandler);
router.get('/requests', getSkillSwapState as RequestHandler);
router.post('/requests', createSkillSwapRequest as RequestHandler);
router.post('/requests/:requestId/respond', respondToSkillSwapRequest as RequestHandler);
router.post('/sessions/:sessionId/complete', completeSkillSwapSession as RequestHandler);

export default router;
