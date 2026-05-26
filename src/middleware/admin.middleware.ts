import { Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { isAuthSessionTwoFactorVerified } from '../services/auth-session.service';

export const requireAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: String(userId) },
      select: { isAdmin: true, role: true, adminTwoFactorEnabled: true },
    });

    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    if (
      user.adminTwoFactorEnabled &&
      !(await isAuthSessionTwoFactorVerified(req.user?.sessionId, String(userId)))
    ) {
      res.status(403).json({
        error: 'Two-factor authentication required',
        code: 'two_factor_required',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
