import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getChallenges,
  getChallenge,
  getDailyChallenge,
  getCategories,
  submitSolution,
  getMySubmissions,
  getLeaderboard,
  getMyStats,
  runCode,
} from '../controllers/challenges.controller';

const router = Router();

// Public routes
router.get('/', getChallenges);
router.get('/categories', getCategories);
router.get('/leaderboard', getLeaderboard);
router.get('/daily', getDailyChallenge);
router.get('/:slug', getChallenge);

// Protected routes
router.use(authenticate);

router.post('/:challengeId/submit', submitSolution);
router.post('/:challengeId/run', runCode);
router.get('/submissions/me', getMySubmissions);
router.get('/stats/me', getMyStats);

export default router;
