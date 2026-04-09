import { Request, Response } from 'express';

interface AuthRequest extends Request {
  user?: { userId: string };
}

// Get all challenges
export const getChallenges = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category, difficulty, search } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch challenges' });
  }
};

// Get challenge by slug
export const getChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    res.status(404).json({ error: 'Challenge not found' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch challenge' });
  }
};

// Get daily challenge
export const getDailyChallenge = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      id: 'daily-1',
      title: 'Daily Challenge',
      description: 'No daily challenge available',
      difficulty: 'MEDIUM',
      xpReward: 50,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch daily challenge' });
  }
};

// Get challenge categories
export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(['Arrays', 'Strings', 'Trees', 'Graphs', 'Dynamic Programming', 'Math']);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

// Submit solution
export const submitSolution = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { challengeId } = req.params;
    const { code, language } = req.body;

    res.json({
      id: `submission-${Date.now()}`,
      status: 'pending',
      passedTests: 0,
      totalTests: 0,
      xpEarned: 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit solution' });
  }
};

// Get my submissions
export const getMySubmissions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { challengeId } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};

// Get leaderboard
export const getLeaderboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category, period, limit = 10 } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};

// Get my stats
export const getMyStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    res.json({
      totalSolved: 0,
      totalAttempted: 0,
      easyCount: 0,
      mediumCount: 0,
      hardCount: 0,
      currentStreak: 0,
      bestStreak: 0,
      rank: null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

// Run code (test without submitting)
export const runCode = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { challengeId } = req.params;
    const { code, language } = req.body;

    res.json({
      output: '',
      error: null,
      runtime: 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run code' });
  }
};
