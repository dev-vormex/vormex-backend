import { Request, Response, NextFunction } from 'express';
import { ActivityType } from '../types/activity.types';
import * as activityService from '../services/activity.service';

interface AuthRequest extends Request {
  user?: { userId: string | number };
}

/**
 * Middleware factory to track user activity automatically
 * Only tracks after successful operations (2xx status codes)
 * 
 * @param activityType - Type of activity to track
 * @returns Express middleware function
 */
export function trackActivity(activityType: ActivityType) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    // Only track after successful operation
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user?.userId) {
        // Convert userId to string (handles both string and number types)
        const userId = String(req.user.userId);

        // Fire and forget - don't wait for completion
        activityService
          .recordActivity(userId, activityType, 1)
          .catch((err) => console.error('Failed to record activity:', err));
      }
    });

    next();
  };
}

