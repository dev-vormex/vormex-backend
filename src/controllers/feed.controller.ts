import { Request, Response } from 'express';

interface AuthRequest extends Request {
  user?: { userId: string };
}

// Get reward data for variable rewards system
export const getRewardData = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      data: {
        data: {
          hasNewMatches: false,
          matches: [],
          hasTrendingSpike: false,
          trendingData: null,
          hasHiddenGems: false,
          hiddenGems: [],
          hasNewMilestones: false,
          milestones: [],
          hasNewOpportunities: false,
          opportunities: [],
          hasNewViewers: false,
          viewers: [],
          canGetSurpriseBoost: false,
          surpriseBoostData: null,
          hasConnectionUpdates: false,
          connectionUpdates: null,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reward data' });
  }
};

// Mark reward as shown
export const markRewardShown = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark reward as shown' });
  }
};
