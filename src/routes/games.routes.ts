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
import {
  abandonArcadeRoomController,
  finishArcadeRoomController,
  getArcadeCatalog,
  getArcadeHistory,
  getArcadeInvite,
  getArcadeLeaderboard,
  getArcadeRoom,
  getArcadeRooms,
  joinArcadeRoomById,
  joinArcadeRoomByInvite,
  postArcadeRoom,
  readyArcadeRoom,
} from '../controllers/arcade.controller';

const router = Router();

// Stats & History
router.get('/stats', authenticate, getMyGameStats);
router.get('/xp-history', authenticate, getXPHistory);
router.get('/leaderboard', optionalAuth, getLeaderboard);

// Social Arcade
router.get('/arcade/catalog', optionalAuth, getArcadeCatalog);
router.get('/arcade/rooms', optionalAuth, getArcadeRooms);
router.post('/arcade/rooms', authenticate, postArcadeRoom);
router.get('/arcade/rooms/:roomId', authenticate, getArcadeRoom);
router.post('/arcade/rooms/:roomId/join', authenticate, joinArcadeRoomById);
router.post('/arcade/rooms/:roomId/ready', authenticate, readyArcadeRoom);
router.post('/arcade/rooms/:roomId/finish', authenticate, finishArcadeRoomController);
router.post('/arcade/rooms/:roomId/abandon', authenticate, abandonArcadeRoomController);
router.get('/arcade/invite/:inviteCode', authenticate, getArcadeInvite);
router.post('/arcade/invite/:inviteCode/join', authenticate, joinArcadeRoomByInvite);
router.get('/arcade/history', authenticate, getArcadeHistory);
router.get('/arcade/leaderboard', optionalAuth, getArcadeLeaderboard);

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
