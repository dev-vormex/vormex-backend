import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import { getPremiumAccessSnapshot } from '../services/premium-access.service';

export async function requireAgentAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    if (!snapshot.canUseAgent) {
      res.status(403).json({
        error: 'AI Agent access is not enabled for this account yet.',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('requireAgentAccess error:', error);
    res.status(500).json({ error: 'Failed to verify AI Agent access' });
  }
}
