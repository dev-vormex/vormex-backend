import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import type { ProfileResponse, ProfileSectionsResponse, UnifiedFeedResponse } from "../../types/profile.types";
import { ensureString } from "../../../../shared/utils/request.util";
import * as profileService from "../../services/profile.service";
import { prisma } from "../../../../config/prisma";
import { isUUID } from "../../../../shared/utils/username.util";
import { areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { isProfileUnavailable, sendResourceUnavailable } from "./support.controller";

/**
 * Get full user profile
 * GET /api/users/:userId/profile
 * Supports both UUID and username (e.g., /users/@koushik or /users/uuid-here)
 * Public route but respects privacy settings
 */
export const getProfile = async (
  req: AuthenticatedRequest,
  res: Response<ProfileResponse | ErrorResponse>
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

    // Remove @ prefix if present (e.g., @koushik -> koushik)
    if (userId.startsWith('@')) {
      userId = userId.substring(1);
    }

    // Resolve "me" to authenticated user's ID
    if (userId.toLowerCase() === 'me') {
      if (!requestingUserId) {
        res.status(401).json({
          error: 'Authentication required to view own profile',
        });
        return;
      }
      userId = requestingUserId;
    }

    // Enforce the bilateral block boundary before either cached profile path.
    if (await isProfileUnavailable(requestingUserId, userId)) {
      sendResourceUnavailable(res);
      return;
    }

    const includes = (ensureString(req.query.include) || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    // Default to the 2-3 query core payload; explicit include=all preserves the legacy bundle.
    const profile = includes.includes('all')
      ? await profileService.getFullProfile(requestingUserId, userId)
      : await profileService.getCoreProfile(requestingUserId, userId);

    res.status(200).json(profile);
  } catch (error) {
    console.error('Error getting profile:', error);

    if (error instanceof Error) {
      if (error.message === 'User not found') {
        res.status(404).json({
          error: 'User not found',
        });
        return;
      }

      if (
        error.message.includes('private') ||
        error.message.includes('Authentication required')
      ) {
        res.status(403).json({
          error: error.message,
        });
        return;
      }
    }

    res.status(500).json({
      error: 'Failed to fetch profile',
    });
  }
};

export const getProfileSections = async (
  req: AuthenticatedRequest,
  res: Response<ProfileSectionsResponse | ErrorResponse>
): Promise<void> => {
  try {
    let userId = ensureString(req.params.userId);
    const requestingUserId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(400).json({ error: 'User ID or username is required' });
      return;
    }
    if (userId.startsWith('@')) userId = userId.substring(1);
    if (userId.toLowerCase() === 'me') {
      if (!requestingUserId) {
        res.status(401).json({ error: 'Authentication required to view own profile' });
        return;
      }
      userId = requestingUserId;
    }

    if (await isProfileUnavailable(requestingUserId, userId)) {
      sendResourceUnavailable(res);
      return;
    }

    const sections = await profileService.getProfileSections(userId);
    res.status(200).json(sections);
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    console.error('Error getting profile sections:', error);
    res.status(500).json({ error: 'Failed to fetch profile sections' });
  }
};

/**
 * Get unified content feed for a user
 * GET /api/users/:userId/feed
 * Supports both UUID and username
 * Public route
 */
export const getProfileFeed = async (
  req: AuthenticatedRequest,
  res: Response<UnifiedFeedResponse | ErrorResponse>
): Promise<void> => {
  try {
    let userId = ensureString(req.params.userId);
    const requestingUserId = req.user?.userId ? String(req.user.userId) : null;
    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = Math.min(parseInt(ensureString(req.query.limit) || '20') || 20, 100); // Max 100
    const filter = ensureString(req.query.filter) || 'all';

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

    // Android uses "me" for the signed-in user's profile. Without resolving it here,
    // the initial embedded activity works but every filter request searches for a
    // literal username named "me" and returns 404.
    if (userId.toLowerCase() === 'me') {
      if (!requestingUserId) {
        res.status(401).json({ error: 'Authentication is required to load your activity' });
        return;
      }
      userId = requestingUserId;
    }

    if (await isProfileUnavailable(requestingUserId, userId)) {
      sendResourceUnavailable(res);
      return;
    }

    // Validate filter
    const validFilters = ['all', 'posts', 'articles', 'forum', 'videos'];
    if (!validFilters.includes(filter)) {
      res.status(400).json({
        error: `Invalid filter. Must be one of: ${validFilters.join(', ')}`,
      });
      return;
    }

    // Find user by UUID or username
    const user = await prisma.user.findFirst({
      where: isUUID(userId)
        ? { id: userId }
        : { username: userId.toLowerCase() },
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

    const feed = await profileService.getUnifiedContentFeed(
      user.id,
      page,
      limit,
      filter as any,
      requestingUserId
    );

    res.status(200).json(feed);
  } catch (error) {
    console.error('Error getting profile feed:', error);
    res.status(500).json({
      error: 'Failed to fetch feed',
    });
  }
};
