import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../../shared/middleware/auth.middleware';
import { createAIRateLimitMiddleware } from '../../../shared/middleware/ai-rate-limit.middleware';
import { requireAgentAccess } from '../../../shared/middleware/agent-access.middleware';
import { validateAIRequestInput, validateMultipartFields } from '../../../shared/middleware/input-validation.middleware';
import { audioUploadRule, validateUploadedFiles } from '../../../shared/middleware/upload-security.middleware';
import { createOrResumeSession, runAgentTurn, runAgentVoiceTurn, getPendingActions, approveAction, rejectAction, getAgentGoals, upsertAgentGoal, deleteAgentGoal } from '../controllers/agent.controller';

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
const validateVoiceUpload = validateUploadedFiles({
  fields: {
    audio: audioUploadRule(20 * 1024 * 1024),
  },
  maxFiles: 1,
  requireKnownField: true,
});

router.use(authenticate);
router.use(requireAgentAccess);

router.post('/sessions', createAIRateLimitMiddleware('career-chat'), validateAIRequestInput, createOrResumeSession);
router.post('/sessions/:sessionId/turns', createAIRateLimitMiddleware('career-chat'), validateAIRequestInput, runAgentTurn);
router.post(
  '/sessions/:sessionId/voice',
  createAIRateLimitMiddleware('career-chat'),
  voiceUpload.single('audio'),
  validateVoiceUpload,
  validateMultipartFields,
  validateAIRequestInput,
  runAgentVoiceTurn
);

// Pending Actions
router.get('/pending-actions', getPendingActions);
router.post('/approve/:actionId', approveAction);
router.post('/reject/:actionId', rejectAction);

// Goals
router.get('/goals', getAgentGoals);
router.post('/goals', createAIRateLimitMiddleware('career-chat'), validateAIRequestInput, upsertAgentGoal);
router.delete('/goals/:goalId', deleteAgentGoal);

export default router;
