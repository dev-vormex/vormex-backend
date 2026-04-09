import { Request, Response } from 'express';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const BADGES = [
  {
    id: 'badge-1',
    name: 'First Post',
    description: 'Create your first post',
    category: 'content',
    iconUrl: null,
    xpReward: 50,
    rarity: 'common',
  },
  {
    id: 'badge-2',
    name: 'Network Starter',
    description: 'Make your first 5 connections',
    category: 'networking',
    iconUrl: null,
    xpReward: 100,
    rarity: 'common',
  },
  {
    id: 'badge-3',
    name: 'Streak Master',
    description: 'Maintain a 7-day login streak',
    category: 'engagement',
    iconUrl: null,
    xpReward: 200,
    rarity: 'rare',
  },
  {
    id: 'badge-4',
    name: 'Quiz Champion',
    description: 'Win 10 trivia games',
    category: 'games',
    iconUrl: null,
    xpReward: 500,
    rarity: 'epic',
  },
];

// Get all badges
export const getAllBadges = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(BADGES);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch badges' });
  }
};

// Get user badges
export const getUserBadges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user badges' });
  }
};

// Get my badges
export const getMyBadges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch my badges' });
  }
};

// Get badge categories
export const getBadgeCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(['content', 'networking', 'engagement', 'games', 'special']);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

// Get badge progress
export const getBadgeProgress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch badge progress' });
  }
};

// Check for new badges
export const checkForBadges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check badges' });
  }
};

// Get unnotified badges
export const getUnnotifiedBadges = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch unnotified badges' });
  }
};

// Get badge leaderboard
export const getBadgeLeaderboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { limit = 10 } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};
