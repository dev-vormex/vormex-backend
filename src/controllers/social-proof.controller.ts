import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { socialProofService } from '../services/social-proof.service';
import { ensureString } from '../utils/request.util';
import { canViewGroup } from '../utils/access-control.util';
import {
  normalizeActivityType,
  normalizeOptionalTrackingText,
  normalizeRequiredTrackingId,
  normalizeSocialProofMetadata,
} from '../utils/social-proof-input.util';
import {
  ensurePremiumFeatureAccess,
  type PremiumFeatureKey,
} from '../services/premium-feature-gates.service';

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

async function ensureOwnPremiumInsightAccess(
  requestingUserId: string,
  userId: string,
  feature: PremiumFeatureKey,
  res: Response,
  forbiddenMessage: string
): Promise<boolean> {
  if (userId !== requestingUserId) {
    res.status(403).json({ success: false, error: forbiddenMessage });
    return false;
  }

  const premiumAccess = await ensurePremiumFeatureAccess(requestingUserId, feature);
  if (premiumAccess.ok === false) {
    res.status(premiumAccess.statusCode).json(premiumAccess.payload);
    return false;
  }

  return true;
}

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
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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

    const viewedIdResult = normalizeRequiredTrackingId(viewedId, 'viewedId');
    if (!viewedIdResult.ok) {
      res.status(400).json({ success: false, error: viewedIdResult.error });
      return;
    }

    const sourceResult = normalizeOptionalTrackingText(source, 'source');
    if (!sourceResult.ok) {
      res.status(400).json({ success: false, error: sourceResult.error });
      return;
    }

    await socialProofService.trackProfileView(viewerId, viewedIdResult.value!, sourceResult.value);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking profile view:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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

    if (!(await ensureOwnPremiumInsightAccess(
      requestingUserId,
      userId,
      'profile_viewers',
      res,
      'You can only view your own profile analytics'
    ))) {
      return;
    }

    const stats = await socialProofService.getProfileViewStats(userId);
    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting profile views:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};

// GET /api/social-proof/profile-views/:userId/history
export const getProfileViewHistory = async (req: Request, res: Response) => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ success: false, error: 'User ID is required' });
      return;
    }

    const requestingUserId = (req as any).user.userId;
    if (!(await ensureOwnPremiumInsightAccess(
      requestingUserId,
      userId,
      'profile_viewers',
      res,
      'You can only view your own profile analytics'
    ))) {
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1', 10) || 1;
    const limit = parseInt(ensureString(req.query.limit) || '50', 10) || 50;

    const history = await socialProofService.getProfileViewHistory(userId, page, limit);
    res.json({ success: true, data: history });
  } catch (error: any) {
    console.error('Error getting profile view history:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};

// POST /api/social-proof/profile-saves/:targetUserId/toggle
export const toggleProfileSave = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const targetUserId = ensureString(req.params.targetUserId);

    if (!targetUserId) {
      res.status(400).json({ success: false, error: 'Target user ID is required' });
      return;
    }

    const result = await socialProofService.toggleProfileSave(userId, targetUserId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('Error toggling profile save:', error);
    const statusCode = error?.message === 'User not found'
      ? 404
      : error?.message === 'Invalid target user'
        ? 400
        : 500;
    res.status(statusCode).json({ success: false, error: error.message });
  }
};

// GET /api/social-proof/profile-saves/:userId
export const getProfileSaves = async (req: Request, res: Response) => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ success: false, error: 'User ID is required' });
      return;
    }

    const requestingUserId = (req as any).user.userId;
    if (!(await ensureOwnPremiumInsightAccess(
      requestingUserId,
      userId,
      'profile_savers',
      res,
      'You can only view your own profile saves'
    ))) {
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1', 10) || 1;
    const limit = parseInt(ensureString(req.query.limit) || '50', 10) || 50;
    const savers = await socialProofService.getProfileSavers(userId, page, limit);
    res.json({ success: true, data: savers });
  } catch (error: any) {
    console.error('Error getting profile savers:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};

// GET /api/social-proof/recent-profile-views
export const getRecentProfileViews = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.userId;
    const page = parseInt(ensureString(req.query.page) || '1', 10) || 1;
    const limit = parseInt(ensureString(req.query.limit) || '50', 10) || 50;
    const recentProfiles = await socialProofService.getRecentlyViewedProfiles(userId, page, limit);
    res.json({ success: true, data: recentProfiles });
  } catch (error: any) {
    console.error('Error getting recently viewed profiles:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};

// GET /api/social-proof/profile-insights/:userId
export const getProfileInsights = async (req: Request, res: Response) => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ success: false, error: 'User ID is required' });
      return;
    }

    const requestingUserId = (req as any).user.userId;
    if (!(await ensureOwnPremiumInsightAccess(
      requestingUserId,
      userId,
      'profile_insights',
      res,
      'You can only view your own profile insights'
    ))) {
      return;
    }

    const insights = await socialProofService.getProfileInsights(userId);
    res.json({ success: true, data: insights });
  } catch (error: any) {
    console.error('Error getting profile insights:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, isPrivate: true, creatorId: true },
    });
    if (!group || !(await canViewGroup(group, userId))) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const stats = await socialProofService.getGroupStats(groupId, userId);

    if (!stats) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    res.json({ success: true, data: stats });
  } catch (error: any) {
    console.error('Error getting group stats:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};

// POST /api/social-proof/track-event-view
export const trackEventView = async (req: Request, res: Response) => {
  try {
    const viewerId = (req as any).user?.userId;
    const { eventId } = req.body;

    const eventIdResult = normalizeRequiredTrackingId(eventId, 'eventId');
    if (!eventIdResult.ok) {
      res.status(400).json({ success: false, error: eventIdResult.error });
      return;
    }

    await socialProofService.trackEventView(eventIdResult.value!, viewerId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error tracking event view:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};

// POST /api/social-proof/record-activity
export const recordActivity = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { activityType, metadata } = req.body;

    const activityTypeResult = normalizeActivityType(activityType);
    if (!activityTypeResult.ok) {
      res.status(400).json({ success: false, error: activityTypeResult.error });
      return;
    }

    const metadataResult = normalizeSocialProofMetadata(metadata);
    if (!metadataResult.ok) {
      res.status(400).json({ success: false, error: metadataResult.error });
      return;
    }

    await socialProofService.recordActivity(userId, activityTypeResult.value!, metadataResult.value!);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error recording activity:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    res.status(500).json({ success: false, error: 'Request could not be completed' });
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
    const currentPageResult = normalizeOptionalTrackingText(currentPage, 'currentPage');
    if (!currentPageResult.ok) {
      res.status(400).json({ success: false, error: currentPageResult.error });
      return;
    }

    await socialProofService.updateUserActivity(userId, currentPageResult.value);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error updating activity:', error);
    res.status(500).json({ success: false, error: 'Request could not be completed' });
  }
};
