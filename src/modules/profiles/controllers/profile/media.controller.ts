import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { enqueueOutboxEvent } from "../../../../infrastructure/outbox/service";
import { queueNames } from "../../../../infrastructure/queue/queue-names";

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
      error: 'Failed to update banner',
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
      error: 'Failed to update avatar',
    });
  }
};
