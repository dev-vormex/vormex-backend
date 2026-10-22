import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import type { ActivityHeatmapResponse } from "../../../engagement/types/activity.types";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { isUUID } from "../../../../shared/utils/username.util";
import { areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { getActivityHeatmap, getContributionYears } from "../../../engagement/services/activity.service";
import { sendResourceUnavailable } from "./support.controller";

/**
 * Get user activity heatmap (GitHub-style contribution calendar)
 * GET /api/users/:userId/activity?year=2024
 * Supports both UUID and username
 * Public route
 */
export const getUserActivity = async (
  req: AuthenticatedRequest,
  res: Response<ActivityHeatmapResponse | ErrorResponse>
): Promise<void> => {
  try {
    let userId = ensureString(req.params.userId);
    const requestingUserId = req.user?.userId ? String(req.user.userId) : null;
    const yearParam = ensureString(req.query.year);

    if (!userId) {
      res.status(400).json({
        error: 'User ID or username is required',
      });
      return;
    }

    // Remove @ prefix if present
    if (userId.startsWith('@')) {
      userId = userId.substring(1);
    }

    // Validate and parse year parameter
    let year: number | undefined;
    if (yearParam !== undefined) {
      year = parseInt(yearParam, 10);
      if (isNaN(year)) {
        res.status(400).json({
          error: 'year must be a valid number',
        });
        return;
      }

      // Validate year is not in the future
      const currentYear = new Date().getUTCFullYear();
      if (year > currentYear) {
        res.status(400).json({
          error: 'Invalid year: cannot be in the future',
        });
        return;
      }
    }

    // Verify user exists (by UUID or username)
    const user = await prisma.user.findFirst({
      where: isUUID(userId)
        ? { id: userId }
        : { username: userId.toLowerCase() },
      select: { id: true, createdAt: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    if (requestingUserId && user.id !== requestingUserId && await areUsersBlocked(requestingUserId, user.id)) {
      sendResourceUnavailable(res);
      return;
    }

    // Validate year is not before user joined
    if (year !== undefined) {
      const joinedYear = user.createdAt.getUTCFullYear();
      if (year < joinedYear) {
        res.status(400).json({
          error: `Invalid year: year ${year} is before user joined (${joinedYear})`,
        });
        return;
      }
    }

    // Get activity heatmap (use user.id, not userId param which might be username)
    const heatmap = await getActivityHeatmap(user.id, year);

    res.status(200).json(heatmap);
  } catch (error) {
    console.error('Error getting user activity:', error);
    res.status(500).json({
      error: 'Failed to fetch activity data',
    });
  }
};

/**
 * Get available contribution years for a user
 * GET /api/users/:userId/activity/years
 * Supports both UUID and username
 * Public route
 */
export const getUserActivityYears = async (
  req: AuthenticatedRequest,
  res: Response<{ years: number[]; joinedYear: number } | ErrorResponse>
): Promise<void> => {
  try {
    let userId = ensureString(req.params.userId);
    const requestingUserId = req.user?.userId ? String(req.user.userId) : null;

    if (!userId) {
      res.status(400).json({
        error: 'User ID or username is required',
      });
      return;
    }

    // Remove @ prefix if present
    if (userId.startsWith('@')) {
      userId = userId.substring(1);
    }

    // Verify user exists (by UUID or username)
    const user = await prisma.user.findFirst({
      where: isUUID(userId)
        ? { id: userId }
        : { username: userId.toLowerCase() },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    if (requestingUserId && user.id !== requestingUserId && await areUsersBlocked(requestingUserId, user.id)) {
      sendResourceUnavailable(res);
      return;
    }

    // Get contribution years (use user.id, not userId param which might be username)
    const yearsData = await getContributionYears(user.id);

    res.status(200).json(yearsData);
  } catch (error) {
    console.error('Error getting activity years:', error);
    res.status(500).json({
      error: 'Failed to fetch activity years',
    });
  }
};
