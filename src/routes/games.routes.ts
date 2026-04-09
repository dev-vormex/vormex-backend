import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  getMyGameStats,
  getXPHistory,
  getLeaderboard,
  getDailyTrivia,
  answerTriviaQuestion,
  getDailyWordle,
  guessWordle,
  getTriviaQuestions,
  getCodingProblems,
  getCodingProblem,
  submitCodingSolution,
  createQuizBattle,
  getAvailableBattles,
  joinQuizBattle,
  getQuizBattle,
  answerBattleQuestion,
  getTypingTexts,
  startTypingRace,
  finishTypingRace,
  getTypingHistory,
} from '../controllers/games.controller';

const router = Router();

// Stats & History
router.get('/stats', authenticate, getMyGameStats);
router.get('/xp-history', authenticate, getXPHistory);
router.get('/leaderboard', optionalAuth, getLeaderboard);

// Trivia
router.get('/trivia/daily', authenticate, getDailyTrivia);
router.get('/trivia/questions', authenticate, getTriviaQuestions);
router.post('/trivia/answer', authenticate, answerTriviaQuestion);

// Wordle
router.get('/wordle/daily', authenticate, getDailyWordle);
router.post('/wordle/guess', authenticate, guessWordle);

// Coding Challenges
router.get('/coding/problems', authenticate, getCodingProblems);
router.get('/coding/problems/:problemId', authenticate, getCodingProblem);
router.post('/coding/problems/:problemId/submit', authenticate, submitCodingSolution);

// Quiz Battles
router.post('/battle/create', authenticate, createQuizBattle);
router.get('/battle/available', authenticate, getAvailableBattles);
router.post('/battle/:battleId/join', authenticate, joinQuizBattle);
router.get('/battle/:battleId', authenticate, getQuizBattle);
router.post('/battle/:battleId/answer', authenticate, answerBattleQuestion);

// Typing Races
router.get('/typing/texts', authenticate, getTypingTexts);
router.post('/typing/start', authenticate, startTypingRace);
router.post('/typing/:raceId/finish', authenticate, finishTypingRace);
router.get('/typing/history', authenticate, getTypingHistory);

export default router;
