import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  getLiveStats,
  trackProfileView,
  getProfileViews,
  getLeaderboard,
  getGroupStats,
  getEventStats,
  trackEventView,
  getActivityFeed,
  recordActivity,
  getTrending,
  getOnboardingStats,
  updateActivity,
} from '../controllers/social-proof.controller';

const router = Router();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC routes (some social proof should be visible to non-logged-in users)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Live activity stats — visible to all (bandwagon effect on landing page)
router.get('/live-stats', optionalAuth, getLiveStats);

// Onboarding social proof — visible to all (signup page numbers)
router.get('/onboarding-stats', getOnboardingStats);

// Leaderboard — visible to all (competitive aspirational content)
router.get('/leaderboard', optionalAuth, getLeaderboard);

// Trending items — visible to all
router.get('/trending', getTrending);

// Activity feed — visible to all (anonymized)
router.get('/activity-feed', getActivityFeed);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTHENTICATED routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

router.use(authenticate);

// Profile view tracking & analytics
router.post('/track-view', trackProfileView);
router.get('/profile-views/:userId', getProfileViews);

// Group/circle stats
router.get('/group-stats/:groupId', getGroupStats);

// Event stats & tracking
router.get('/event-stats/:eventId', getEventStats);
router.post('/track-event-view', trackEventView);

// Record social activity
router.post('/record-activity', recordActivity);

// User activity heartbeat
router.post('/heartbeat', updateActivity);

export default router;
