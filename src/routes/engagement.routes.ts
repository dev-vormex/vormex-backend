import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getStreaks,
  recordLogin,
  getDailyMatches,
  getPeopleLikeYou,
  getHiddenGem,
  getTrendingStatus,
  getLiveActivity,
  getLeaderboard,
  getNudges,
  getWeeklyGoals,
  getConnectionLimit,
  getSessionSummary,
  getConnectionCelebration,
  getStreakHistory,
  getDashboard,
  getRecentJoins,
  getPublicStreaks,
  purchaseStreakFreeze,
  toggleStreakShield,
  getStreakLeaderboard,
  toggleStreakVisibility,
  getRewardCards,
  postRewardEvent,
} from '../controllers/engagement.controller';

const router = Router();

// All engagement routes require authentication
router.use(authenticate);

// Dashboard
router.get('/dashboard', getDashboard);

// Streaks
router.get('/streaks', getStreaks);
router.get('/streaks/history', getStreakHistory);
router.get('/streaks/leaderboard', getStreakLeaderboard);
router.get('/streaks/:userId', getPublicStreaks);
router.post('/streaks/freeze', purchaseStreakFreeze);
router.post('/streaks/shield', toggleStreakShield);
router.post('/streaks/visibility', toggleStreakVisibility);

// Login tracking
router.post('/login', recordLogin);

// App-open reward cards
router.get('/reward-cards', getRewardCards);
router.post('/reward-events', postRewardEvent);

// Daily matches
router.get('/daily-matches', getDailyMatches);
router.get('/people-like-you', getPeopleLikeYou);
router.get('/hidden-gem', getHiddenGem);
router.get('/trending-status', getTrendingStatus);

// Live activity / Social proof
router.get('/live-activity', getLiveActivity);

// Leaderboard
router.get('/leaderboard', getLeaderboard);

// Progress nudges
router.get('/nudges', getNudges);

// Weekly goals
router.get('/weekly-goals', getWeeklyGoals);

// Connection limit
router.get('/connection-limit', getConnectionLimit);

// Session summary
router.get('/session-summary', getSessionSummary);

// Recent joins
router.get('/recent-joins', getRecentJoins);

// Celebration
router.get('/celebration/:connectionId', getConnectionCelebration);

export default router;
