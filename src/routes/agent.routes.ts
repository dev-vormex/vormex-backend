import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { createAIRateLimitMiddleware } from '../middleware/ai-rate-limit.middleware';
import { requireAgentAccess } from '../middleware/agent-access.middleware';
import {
  createOrResumeSession,
  runAgentTurn,
  runAgentVoiceTurn,
  getPendingActions,
  approveAction,
  rejectAction,
  getAgentGoals,
  upsertAgentGoal,
  deleteAgentGoal,
} from '../controllers/agent.controller';

const router = Router();
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1,
    parts: 5,
    fieldSize: 128 * 1024,
  },
});

router.use(authenticate);
router.use(requireAgentAccess);

router.post('/sessions', createAIRateLimitMiddleware('career-chat'), createOrResumeSession);
router.post('/sessions/:sessionId/turns', createAIRateLimitMiddleware('career-chat'), runAgentTurn);
router.post(
  '/sessions/:sessionId/voice',
  createAIRateLimitMiddleware('career-chat'),
  voiceUpload.single('audio'),
  runAgentVoiceTurn
);

// Pending Actions
router.get('/pending-actions', getPendingActions);
router.post('/approve/:actionId', approveAction);
router.post('/reject/:actionId', rejectAction);

// Goals
router.get('/goals', getAgentGoals);
router.post('/goals', createAIRateLimitMiddleware('career-chat'), upsertAgentGoal);
router.delete('/goals/:goalId', deleteAgentGoal);

export default router;
