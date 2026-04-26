import { Request, Response } from 'express';
import { getProgressOverview } from '../services/progress.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

export const getMyProgress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const progress = await getProgressOverview(userId);
    res.json({ data: progress });
  } catch (error) {
    console.error('getMyProgress error:', error);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
};
