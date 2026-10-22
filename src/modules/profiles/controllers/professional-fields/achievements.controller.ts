import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { ACHIEVEMENT_TYPES, validateUrl, invalidateProfessionalProfileCaches } from "./support.controller";

// ============================================
// ACHIEVEMENTS
// ============================================

/**
 * Create achievement
 * POST /api/users/me/achievements
 */
export const createAchievement = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { title, type, organization, date, description, certificateUrl } = req.body;

    // Validation
    if (!title || typeof title !== 'string' || title.trim().length < 2 || title.length > 100) {
      res.status(400).json({ error: 'title is required and must be 2-100 characters' });
      return;
    }

    if (!type || !ACHIEVEMENT_TYPES.includes(type)) {
      res.status(400).json({
        error: `type must be one of: ${ACHIEVEMENT_TYPES.join(', ')}`,
      });
      return;
    }

    if (!organization || typeof organization !== 'string' || organization.trim().length < 2 || organization.length > 100) {
      res.status(400).json({ error: 'organization is required and must be 2-100 characters' });
      return;
    }

    if (!date) {
      res.status(400).json({ error: 'date is required' });
      return;
    }

    if (description && description.length > 2000) {
      res.status(400).json({ error: 'description must be 2000 characters or less' });
      return;
    }

    if (certificateUrl && !validateUrl(certificateUrl)) {
      res.status(400).json({ error: 'certificateUrl must be a valid URL' });
      return;
    }

    const achievement = await prisma.achievement.create({
      data: {
        userId,
        title: title.trim(),
        type,
        organization: organization.trim(),
        date: new Date(date),
        description: description?.trim() || null,
        certificateUrl: certificateUrl || null,
      },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(201).json(achievement);
  } catch (error) {
    console.error('Error creating achievement:', error);
    res.status(500).json({
      error: 'Failed to create achievement',
    });
  }
};

/**
 * Update achievement
 * PUT /api/users/me/achievements/:id
 */
export const updateAchievement = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const id = ensureString(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    // Verify ownership
    const achievement = await prisma.achievement.findUnique({
      where: { id },
    });

    if (!achievement || achievement.userId !== userId) {
      res.status(404).json({ error: 'Achievement not found' });
      return;
    }

    const updateData: any = {};

    if (req.body.title !== undefined) {
      if (typeof req.body.title !== 'string' || req.body.title.trim().length < 2 || req.body.title.length > 100) {
        res.status(400).json({ error: 'title must be 2-100 characters' });
        return;
      }
      updateData.title = req.body.title.trim();
    }

    if (req.body.type !== undefined) {
      if (!ACHIEVEMENT_TYPES.includes(req.body.type)) {
        res.status(400).json({
          error: `type must be one of: ${ACHIEVEMENT_TYPES.join(', ')}`,
        });
        return;
      }
      updateData.type = req.body.type;
    }

    if (req.body.organization !== undefined) {
      if (typeof req.body.organization !== 'string' || req.body.organization.trim().length < 2 || req.body.organization.length > 100) {
        res.status(400).json({ error: 'organization must be 2-100 characters' });
        return;
      }
      updateData.organization = req.body.organization.trim();
    }

    if (req.body.date !== undefined) {
      updateData.date = new Date(req.body.date);
    }

    if (req.body.description !== undefined) {
      if (req.body.description && req.body.description.length > 2000) {
        res.status(400).json({ error: 'description must be 2000 characters or less' });
        return;
      }
      updateData.description = req.body.description?.trim() || null;
    }

    if (req.body.certificateUrl !== undefined) {
      if (req.body.certificateUrl && !validateUrl(req.body.certificateUrl)) {
        res.status(400).json({ error: 'certificateUrl must be a valid URL' });
        return;
      }
      updateData.certificateUrl = req.body.certificateUrl || null;
    }

    const updated = await prisma.achievement.update({
      where: { id },
      data: updateData,
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating achievement:', error);
    res.status(500).json({
      error: 'Failed to update achievement',
    });
  }
};

/**
 * Delete achievement
 * DELETE /api/users/me/achievements/:id
 */
export const deleteAchievement = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const id = ensureString(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    // Verify ownership
    const achievement = await prisma.achievement.findUnique({
      where: { id },
    });

    if (!achievement || achievement.userId !== userId) {
      res.status(404).json({ error: 'Achievement not found' });
      return;
    }

    await prisma.achievement.delete({
      where: { id },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json({ message: 'Achievement deleted successfully' });
  } catch (error) {
    console.error('Error deleting achievement:', error);
    res.status(500).json({
      error: 'Failed to delete achievement',
    });
  }
};

/**
 * Get user achievements
 * GET /api/users/:userId/achievements
 */
export const getUserAchievements = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const achievements = await prisma.achievement.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
    });

    res.status(200).json(achievements);
  } catch (error) {
    console.error('Error getting achievements:', error);
    res.status(500).json({
      error: 'Failed to fetch achievements',
    });
  }
};
