import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getPremiumProfileCustomizationFields, ensurePremiumFeatureAccess } from "../../../premium/services/premium-feature-gates.service";
import { isProfileThemeKey, normalizeProfileThemeForStorage, serializeProfileTheme } from "../../constants/profile-themes";
import { prisma } from "../../../../config/prisma";
import { enqueueOutboxEvent } from "../../../../infrastructure/outbox/service";
import { queueNames } from "../../../../infrastructure/queue/queue-names";
import { normalizeOptionalText as normalizeProfileField, arraysEqual as profileInterestArraysEqual, normalizeStringList as normalizeProfileInterests } from "../../utils/profile-fields.util";
import { queueMatchAvailabilityNotifications } from "../../../notifications/services/match-availability-notification.service";
import { reindexPublicProfile } from "../../../discovery/services/public-discovery.service";
import { normalizeProfileBadgeStyle, uniqueCacheTags } from "./support.controller";

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

    if (affectsPeopleCards) {
      void reindexPublicProfile(userId).catch((error) => {
        console.warn('Failed to refresh public discovery profile index', error instanceof Error ? error.message : error);
      });
    }

    res.status(200).json({
      ...updatedUser,
      profileTheme: serializeProfileTheme(updatedUser.profileTheme),
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      error: 'Failed to update profile',
    });
  }
};
