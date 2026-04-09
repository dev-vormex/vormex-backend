import { Request, Response } from 'express';
import { socialProofService } from '../services/social-proof.service';
import { ensureString } from '../utils/request.util';

/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SOCIAL PROOF & FOMO CONTROLLER
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Exposes endpoints for social proof features: live stats, profile views,
 * leaderboard, group stats, event stats, activity feed, trending, onboarding.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. LIVE ACTIVITY STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/live-stats
export const getLiveStats = async (req: Request, res: Response) => {
  try {
    const city = req.query.city as string | undefined;
    const college = req.query.college as string | undefined;
    const userId = (req as any).user?.userId;
    const stats = await socialProofService.getLiveStats({ city, college, userId });
    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting live stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. PROFILE VIEWS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /api/social-proof/track-view
export const trackProfileView = async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user.userId;
    const { viewedId, source } = req.body;

    if (!viewedId) {
      res.status(400).json({ success: false, error: 'viewedId is required' });
      return;
    }

    await socialProofService.trackProfileView(viewerId, viewedId, source);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking profile view:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/social-proof/profile-views/:userId
export const getProfileViews = async (req: Request, res: Response) => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ success: false, error: 'User ID is required' });
      return;
    }
    const requestingUserId = (req as any).user.userId;

    // Only allow users to view their own profile analytics
    if (userId !== requestingUserId) {
      res.status(403).json({ success: false, error: 'You can only view your own profile analytics' });
      return;
    }

    const stats = await socialProofService.getProfileViewStats(userId);
    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting profile views:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. LEADERBOARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/leaderboard
export const getLeaderboard = async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as 'daily' | 'weekly' | 'all_time') || 'weekly';
    const scope = (req.query.scope as string) || 'global';
    const limit = parseInt(req.query.limit as string) || 10;
    const userId = (req as any).user?.userId;

    const leaderboard = await socialProofService.getLeaderboard({ period, scope, limit, userId });
    res.json({ success: true, data: leaderboard });
  } catch (error: any) {
    console.error('Error getting leaderboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. GROUP/CIRCLE STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/group-stats/:groupId
export const getGroupStats = async (req: Request, res: Response) => {
  try {
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ success: false, error: 'Group ID is required' });
      return;
    }
    const userId = (req as any).user?.userId;
    const stats = await socialProofService.getGroupStats(groupId, userId);

    if (!stats) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting group stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. EVENT STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/event-stats/:eventId
export const getEventStats = async (req: Request, res: Response) => {
  try {
    const eventId = ensureString(req.params.eventId);
    if (!eventId) {
      res.status(400).json({ success: false, error: 'Event ID is required' });
      return;
    }
    const userId = (req as any).user?.userId;
    const stats = await socialProofService.getEventStats(eventId, userId);
    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting event stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/social-proof/track-event-view
export const trackEventView = async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user?.userId;
    const { eventId } = req.body;

    if (!eventId) {
      res.status(400).json({ success: false, error: 'eventId is required' });
      return;
    }

    await socialProofService.trackEventView(eventId, viewerId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking event view:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. ACTIVITY FEED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/activity-feed
export const getActivityFeed = async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const minutes = parseInt(req.query.minutes as string) || 10;
    const feed = await socialProofService.getActivityFeed(limit, minutes);
    res.json({ success: true, data: feed });
  } catch (error: any) {
    console.error('Error getting activity feed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/social-proof/record-activity
export const recordActivity = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { activityType, metadata } = req.body;

    if (!activityType) {
      res.status(400).json({ success: false, error: 'activityType is required' });
      return;
    }

    await socialProofService.recordActivity(userId, activityType, metadata || {});
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error recording activity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. TRENDING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/trending
export const getTrending = async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const city = req.query.city as string | undefined;
    const limit = parseInt(req.query.limit as string) || 10;
    const items = await socialProofService.getTrendingItems(type, city, limit);
    res.json({ success: true, data: items });
  } catch (error: any) {
    console.error('Error getting trending items:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. ONBOARDING SOCIAL PROOF
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/social-proof/onboarding-stats
export const getOnboardingStats = async (req: Request, res: Response) => {
  try {
    const college = req.query.college as string | undefined;
    const stats = await socialProofService.getOnboardingStats(college);
    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting onboarding stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. USER ACTIVITY HEARTBEAT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// POST /api/social-proof/heartbeat
export const updateActivity = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const { currentPage } = req.body;
    await socialProofService.updateUserActivity(userId, currentPage);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error updating activity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
