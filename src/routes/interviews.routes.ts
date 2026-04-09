import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getCategories,
  getCategoryBySlug,
  getQuestions,
  getQuestion,
  startSession,
  getMySessions,
  getSession,
  submitResponse,
  completeSession,
  getMyStats,
} from '../controllers/interviews.controller';

const router = Router();

// Public routes
router.get('/categories', getCategories);
router.get('/categories/:slug', getCategoryBySlug);
router.get('/questions', getQuestions);
router.get('/questions/:questionId', getQuestion);

// Protected routes
router.use(authenticate);

router.post('/sessions/start', startSession);
router.get('/sessions', getMySessions);
router.get('/sessions/:sessionId', getSession);
router.post('/responses', submitResponse);
router.post('/sessions/:sessionId/complete', completeSession);
router.get('/stats', getMyStats);

export default router;
