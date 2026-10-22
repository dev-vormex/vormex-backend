import type { AuthenticatedRequest as AuthRequest } from "../../../shared/types/authenticated-request";
import { Response } from 'express';
import { getProgressOverview } from '../services/progress.service';



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
