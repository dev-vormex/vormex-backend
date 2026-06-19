import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { queueNames } from '../infrastructure/queue/queue-names';
import { enqueueOutboxEvent } from '../outbox/service';
import { ensureString } from '../utils/request.util';
import * as profileService from '../services/profile.service';
import { getActivityHeatmap, getContributionYears } from '../services/activity.service';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { isUUID } from '../utils/username.util';
import type { FullProfileResponse, UnifiedFeedResponse } from '../types/profile.types';
import type { ActivityHeatmapResponse } from '../types/activity.types';
import {
  isProfileThemeKey,
  normalizeProfileThemeForStorage,
  serializeProfileTheme,
} from '../constants/profile-themes';
import {
  ensurePremiumFeatureAccess,
  getPremiumProfileCustomizationFields,
} from '../services/premium-feature-gates.service';

const PROFILE_BADGE_STYLES = new Set(['student', 'professional']);

function normalizeProfileBadgeStyle(value: unknown): string | null {
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Profile badge style must be a string');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!PROFILE_BADGE_STYLES.has(normalized)) {
    throw new Error('Profile badge style is not supported');
  }
  return normalized;
}

function normalizeProfileField(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function normalizeProfileInterests(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function profileInterestArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

/**
 * Get full user profile
 * GET /api/users/:userId/profile
 * Supports both UUID and username (e.g., /users/@koushik or /users/uuid-here)
 * Public route but respects privacy settings
 */
export const getProfile = async (
  req: AuthenticatedRequest,
  res: Response<FullProfileResponse | ErrorResponse>
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

    const profile = await profileService.getFullProfile(requestingUserId, userId);

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
      error: error instanceof Error ? error.message : 'Failed to fetch profile',
    });
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
      error: error instanceof Error ? error.message : 'Failed to fetch feed',
    });
  }
};

/**
 * Update user profile
 * PUT /api/users/me
 * Protected route
 * Note: Username cannot be changed after registration (permanent)
 */
export const updateProfile = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const {
      name,
      headline,
      bio,
      location,
      currentYear,
      degree,
      graduationYear,
      portfolioUrl,
      linkedinUrl,
      githubProfileUrl,
      otherSocialUrls,
      isOpenToOpportunities,
      interests,
      profileRing,
      visitLoaderGiftId,
      profileTheme,
      profileBadgeStyle,
      college,
      branch,
      username, // Explicitly ignore username updates
    } = req.body;

    // Username cannot be changed after registration
    if (username !== undefined) {
      res.status(400).json({
        error: 'Username cannot be changed after registration',
      });
      return;
    }

    const premiumCustomizationFields = getPremiumProfileCustomizationFields(req.body);
    if (premiumCustomizationFields.length > 0) {
      const premiumAccess = await ensurePremiumFeatureAccess(userId, 'profile_customization');
      if (premiumAccess.ok === false) {
        res.status(premiumAccess.statusCode).json({
          ...premiumAccess.payload,
          fields: premiumCustomizationFields,
        });
        return;
      }
    }

    // Validate input
    const errors: string[] = [];

    if (name !== undefined) {
      if (typeof name !== 'string') {
        errors.push('Name must be a string');
      } else {
        const trimmedName = name.trim();
        if (trimmedName.length < 1) {
          errors.push('Name cannot be empty');
        } else if (trimmedName.length > 100) {
          errors.push('Name must be 100 characters or less');
        }
      }
    }

    if (headline !== undefined && headline !== null) {
      if (typeof headline !== 'string') {
        errors.push('Headline must be a string');
      } else if (headline.length > 120) {
        errors.push('Headline must be 120 characters or less');
      }
    }

    if (bio !== undefined && bio !== null) {
      if (typeof bio !== 'string') {
        errors.push('Bio must be a string');
      } else if (bio.length > 500) {
        errors.push('Bio must be 500 characters or less');
      }
    }

    if (profileRing !== undefined && profileRing !== null && typeof profileRing !== 'string') {
      errors.push('Profile ring must be a string');
    }

    if (
      visitLoaderGiftId !== undefined &&
      visitLoaderGiftId !== null &&
      typeof visitLoaderGiftId !== 'string'
    ) {
      errors.push('Visit loader gift id must be a string');
    }

    if (profileTheme !== undefined && profileTheme !== null) {
      if (typeof profileTheme !== 'string') {
        errors.push('Profile theme must be a string');
      } else {
        const trimmedTheme = profileTheme.trim();
        if (trimmedTheme && !isProfileThemeKey(trimmedTheme)) {
          errors.push('Profile theme is not supported');
        }
      }
    }

    if (profileBadgeStyle !== undefined) {
      try {
        normalizeProfileBadgeStyle(profileBadgeStyle);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Profile badge style is not supported');
      }
    }

    if (currentYear !== undefined && currentYear !== null) {
      if (typeof currentYear !== 'number' || currentYear < 1 || currentYear > 5) {
        errors.push('Current year must be between 1 and 5');
      }
    }

    // Validate interests
    if (interests !== undefined && interests !== null) {
      if (!Array.isArray(interests)) {
        errors.push('Interests must be an array');
      } else {
        if (interests.length > 10) {
          errors.push('Maximum 10 interests allowed');
        }
        for (const interest of interests) {
          if (typeof interest !== 'string') {
            errors.push('Each interest must be a string');
            break;
          }
          const trimmed = interest.trim();
          if (trimmed.length < 2 || trimmed.length > 30) {
            errors.push('Each interest must be between 2 and 30 characters');
            break;
          }
        }
      }
    }

    // Validate URLs
    const urlFields = {
      portfolioUrl,
      linkedinUrl,
      githubProfileUrl,
    };
    for (const [field, url] of Object.entries(urlFields)) {
      if (url !== undefined && url !== null && url !== '') {
        try {
          new URL(url);
        } catch {
          errors.push(`${field} must be a valid URL`);
        }
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: `Validation failed: ${errors.join(', ')}`,
      });
      return;
    }

    // Process interests: trim, capitalize, remove duplicates
    let processedInterests: string[] | undefined;
    if (interests !== undefined) {
      const normalized = interests
        .map((interest: string) => interest.trim())
        .filter((interest: string) => interest.length >= 2 && interest.length <= 30)
        .map((interest: string) => {
          // Capitalize first letter of each word
          return interest
            .split(/\s+/)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        });
      
      // Remove duplicates (case-insensitive)
      const unique = Array.from(
        new Map(normalized.map((interest: string) => [interest.toLowerCase(), interest])).values()
      ) as string[];
      
      if (unique.length > 10) {
        errors.push('Maximum 10 interests allowed after processing');
      } else {
        processedInterests = unique;
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: `Validation failed: ${errors.join(', ')}`,
      });
      return;
    }

    const shouldCheckMatchSignals = college !== undefined || processedInterests !== undefined;
    const previousSignalState = shouldCheckMatchSignals
      ? await prisma.user.findUnique({
          where: { id: userId },
          select: {
            college: true,
            interests: true,
          },
        })
      : null;

    if (shouldCheckMatchSignals && !previousSignalState) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    // Build update object (only include defined fields)
    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (headline !== undefined) updateData.headline = headline;
    if (bio !== undefined) updateData.bio = bio;
    if (location !== undefined) updateData.location = location;
    if (currentYear !== undefined) updateData.currentYear = currentYear;
    if (degree !== undefined) updateData.degree = degree;
    if (graduationYear !== undefined) updateData.graduationYear = graduationYear;
    if (portfolioUrl !== undefined) updateData.portfolioUrl = portfolioUrl;
    if (linkedinUrl !== undefined) updateData.linkedinUrl = linkedinUrl;
    if (githubProfileUrl !== undefined) updateData.githubProfileUrl = githubProfileUrl;
    if (otherSocialUrls !== undefined) updateData.otherSocialUrls = otherSocialUrls;
    if (isOpenToOpportunities !== undefined)
      updateData.isOpenToOpportunities = isOpenToOpportunities;
    if (processedInterests !== undefined) updateData.interests = processedInterests;
    if (profileRing !== undefined) updateData.profileRing = profileRing?.trim() || null;
    if (visitLoaderGiftId !== undefined) {
      updateData.visitLoaderGiftId = visitLoaderGiftId?.trim() || null;
    }
    if (profileTheme !== undefined) {
      updateData.profileTheme = normalizeProfileThemeForStorage(profileTheme);
    }
    if (profileBadgeStyle !== undefined) {
      updateData.profileBadgeStyle = normalizeProfileBadgeStyle(profileBadgeStyle);
    }
    if (college !== undefined) updateData.college = college?.trim() || null;
    if (branch !== undefined) updateData.branch = branch?.trim() || null;

    const affectsPeopleCards =
      name !== undefined ||
      headline !== undefined ||
      bio !== undefined ||
      location !== undefined ||
      college !== undefined ||
      branch !== undefined ||
      graduationYear !== undefined ||
      isOpenToOpportunities !== undefined ||
      processedInterests !== undefined ||
      profileBadgeStyle !== undefined;
    const affectsMatchRanking =
      college !== undefined ||
      branch !== undefined ||
      graduationYear !== undefined ||
      processedInterests !== undefined;
    const affectsPeopleFilters =
      college !== undefined ||
      branch !== undefined ||
      location !== undefined ||
      graduationYear !== undefined;
    const cacheInvalidationTags = uniqueCacheTags([
      `user:${userId}`,
      `people:user:${userId}`,
      `matching:user:${userId}`,
      affectsPeopleCards ? 'people:global' : '',
      affectsMatchRanking ? 'matching:global' : '',
      affectsPeopleFilters ? 'people:filters' : '',
    ]);

    // Update user
    const updatedUser = await prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          profileImage: true,
          bio: true,
          headline: true,
          location: true,
          currentYear: true,
          degree: true,
          graduationYear: true,
          portfolioUrl: true,
          linkedinUrl: true,
          otherSocialUrls: true,
          isOpenToOpportunities: true,
          bannerImageUrl: true,
          interests: true,
          profileRing: true,
          visitLoaderGiftId: true,
          profileTheme: true,
          profileBadgeStyle: true,
          college: true,
          branch: true,
          updatedAt: true,
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.updated',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: cacheInvalidationTags,
        },
      });

      return result;
    });

    console.log(
      `Profile updated: ${userId}, fields: ${Object.keys(updateData).join(', ')}`
    );

    const shouldTriggerMatchNotifications =
      Boolean(previousSignalState) && (
        (college !== undefined &&
          normalizeProfileField(previousSignalState?.college) !== normalizeProfileField(updatedUser.college)) ||
        (processedInterests !== undefined &&
          !profileInterestArraysEqual(
            normalizeProfileInterests(previousSignalState?.interests),
            normalizeProfileInterests(updatedUser.interests)
          ))
      );

    if (shouldTriggerMatchNotifications) {
      queueMatchAvailabilityNotifications(userId, 'profile_update');
    }

    res.status(200).json({
      ...updatedUser,
      profileTheme: serializeProfileTheme(updatedUser.profileTheme),
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update profile',
    });
  }
};

/**
 * Upload banner image
 * POST /api/users/me/banner
 * Protected route
 */
export const uploadBanner = async (
  req: AuthenticatedRequest,
  res: Response<{ bannerImageUrl: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const { bannerUrl } = req.body;

    if (!bannerUrl || typeof bannerUrl !== 'string') {
      res.status(400).json({
        error: 'bannerUrl is required and must be a string',
      });
      return;
    }

    // Validate URL format
    try {
      new URL(bannerUrl);
    } catch {
      res.status(400).json({
        error: 'bannerUrl must be a valid URL',
      });
      return;
    }

    // Update user
    const updatedUser = await prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: userId },
        data: { bannerImageUrl: bannerUrl },
        select: { bannerImageUrl: true },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.banner.updated',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [
            `user:${userId}`,
            `people:user:${userId}`,
            `matching:user:${userId}`,
            'people:global',
            'matching:global',
          ],
        },
      });

      return result;
    });

    res.status(200).json({
      bannerImageUrl: updatedUser.bannerImageUrl || '',
    });
  } catch (error) {
    console.error('Error uploading banner:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update banner',
    });
  }
};

/**
 * Upload avatar image
 * POST /api/users/me/avatar
 * Protected route
 */
export const uploadAvatar = async (
  req: AuthenticatedRequest,
  res: Response<{ avatar: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const { avatarUrl } = req.body;

    if (!avatarUrl || typeof avatarUrl !== 'string') {
      res.status(400).json({
        error: 'avatarUrl is required and must be a string',
      });
      return;
    }

    // Validate URL format
    try {
      new URL(avatarUrl);
    } catch {
      res.status(400).json({
        error: 'avatarUrl must be a valid URL',
      });
      return;
    }

    // Update user
    const updatedUser = await prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: userId },
        data: { profileImage: avatarUrl },
        select: { profileImage: true },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'profile.avatar.updated',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [
            `user:${userId}`,
            `people:user:${userId}`,
            `matching:user:${userId}`,
            'people:global',
            'matching:global',
          ],
        },
      });

      return result;
    });

    res.status(200).json({
      avatar: updatedUser.profileImage || '',
    });
  } catch (error) {
    console.error('Error uploading avatar:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to update avatar',
    });
  }
};

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
      error: error instanceof Error ? error.message : 'Failed to fetch activity data',
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

    // Get contribution years (use user.id, not userId param which might be username)
    const yearsData = await getContributionYears(user.id);

    res.status(200).json(yearsData);
  } catch (error) {
    console.error('Error getting activity years:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch activity years',
    });
  }
};
