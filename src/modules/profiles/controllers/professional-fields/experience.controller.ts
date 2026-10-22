import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { EXPERIENCE_TYPES, validateDateRange, validateUrl, invalidateProfessionalProfileCaches } from "./support.controller";

// ============================================
// EXPERIENCE
// ============================================

/**
 * Create experience
 * POST /api/users/me/experiences
 */
export const createExperience = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { title, company, type, location, startDate, endDate, isCurrent, description, skills, logo } = req.body;

    // Validation
    if (!title || typeof title !== 'string' || title.trim().length < 2 || title.length > 100) {
      res.status(400).json({ error: 'title is required and must be 2-100 characters' });
      return;
    }

    if (!company || typeof company !== 'string' || company.trim().length < 2 || company.length > 100) {
      res.status(400).json({ error: 'company is required and must be 2-100 characters' });
      return;
    }

    if (!type || !EXPERIENCE_TYPES.includes(type)) {
      res.status(400).json({
        error: `type must be one of: ${EXPERIENCE_TYPES.join(', ')}`,
      });
      return;
    }

    if (!startDate) {
      res.status(400).json({ error: 'startDate is required' });
      return;
    }

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : null;

    if (!validateDateRange(start, end, isCurrent)) {
      res.status(400).json({ error: 'startDate must be before endDate' });
      return;
    }

    if (description && description.length > 2000) {
      res.status(400).json({ error: 'description must be 2000 characters or less' });
      return;
    }

    if (logo && (typeof logo !== 'string' || !validateUrl(logo))) {
      res.status(400).json({ error: 'logo must be a valid URL' });
      return;
    }

    const experience = await prisma.experience.create({
      data: {
        userId,
        title: title.trim(),
        company: company.trim(),
        type,
        location: location?.trim() || null,
        startDate: start,
        endDate: end,
        isCurrent: isCurrent || false,
        description: description?.trim() || null,
        skills: Array.isArray(skills) ? skills : [],
        logo: logo || null,
      },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(201).json(experience);
  } catch (error) {
    console.error('Error creating experience:', error);
    res.status(500).json({
      error: 'Failed to create experience',
    });
  }
};

/**
 * Update experience
 * PUT /api/users/me/experiences/:id
 */
export const updateExperience = async (
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
      res.status(400).json({ error: 'Experience ID is required' });
      return;
    }
    const updateData: any = {};

    // Verify ownership
    const experience = await prisma.experience.findUnique({
      where: { id },
    });

    if (!experience || experience.userId !== userId) {
      res.status(404).json({ error: 'Experience not found' });
      return;
    }

    // Build update data
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== 'string' || req.body.title.trim().length < 2 || req.body.title.length > 100) {
        res.status(400).json({ error: 'title must be 2-100 characters' });
        return;
      }
      updateData.title = req.body.title.trim();
    }

    if (req.body.company !== undefined) {
      if (typeof req.body.company !== 'string' || req.body.company.trim().length < 2 || req.body.company.length > 100) {
        res.status(400).json({ error: 'company must be 2-100 characters' });
        return;
      }
      updateData.company = req.body.company.trim();
    }

    if (req.body.type !== undefined) {
      if (!EXPERIENCE_TYPES.includes(req.body.type)) {
        res.status(400).json({
          error: `type must be one of: ${EXPERIENCE_TYPES.join(', ')}`,
        });
        return;
      }
      updateData.type = req.body.type;
    }

    if (req.body.startDate !== undefined) {
      updateData.startDate = new Date(req.body.startDate);
    }

    if (req.body.endDate !== undefined) {
      updateData.endDate = req.body.endDate ? new Date(req.body.endDate) : null;
    }

    if (req.body.isCurrent !== undefined) {
      updateData.isCurrent = req.body.isCurrent;
    }

    if (req.body.description !== undefined) {
      if (req.body.description && req.body.description.length > 2000) {
        res.status(400).json({ error: 'description must be 2000 characters or less' });
        return;
      }
      updateData.description = req.body.description?.trim() || null;
    }

    if (req.body.skills !== undefined) {
      updateData.skills = Array.isArray(req.body.skills) ? req.body.skills : [];
    }

    if (req.body.location !== undefined) {
      updateData.location = req.body.location?.trim() || null;
    }

    if (req.body.logo !== undefined) {
      if (req.body.logo && (typeof req.body.logo !== 'string' || !validateUrl(req.body.logo))) {
        res.status(400).json({ error: 'logo must be a valid URL' });
        return;
      }
      updateData.logo = req.body.logo || null;
    }

    // Validate date range
    const startDate = updateData.startDate || experience.startDate;
    const endDate = updateData.endDate !== undefined ? updateData.endDate : experience.endDate;
    const isCurrent = updateData.isCurrent !== undefined ? updateData.isCurrent : experience.isCurrent;

    if (!validateDateRange(startDate, endDate, isCurrent)) {
      res.status(400).json({ error: 'startDate must be before endDate' });
      return;
    }

    const updated = await prisma.experience.update({
      where: { id },
      data: updateData,
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating experience:', error);
    res.status(500).json({
      error: 'Failed to update experience',
    });
  }
};

/**
 * Delete experience
 * DELETE /api/users/me/experiences/:id
 */
export const deleteExperience = async (
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
      res.status(400).json({ error: 'Experience ID is required' });
      return;
    }

    // Verify ownership
    const experience = await prisma.experience.findUnique({
      where: { id },
    });

    if (!experience || experience.userId !== userId) {
      res.status(404).json({ error: 'Experience not found' });
      return;
    }

    await prisma.experience.delete({
      where: { id },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json({ message: 'Experience deleted successfully' });
  } catch (error) {
    console.error('Error deleting experience:', error);
    res.status(500).json({
      error: 'Failed to delete experience',
    });
  }
};

/**
 * Get user experiences
 * GET /api/users/:userId/experiences
 */
export const getUserExperiences = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const experiences = await prisma.experience.findMany({
      where: { userId },
      orderBy: [
        { isCurrent: 'desc' },
        { startDate: 'desc' },
      ],
    });

    res.status(200).json(experiences);
  } catch (error) {
    console.error('Error getting experiences:', error);
    res.status(500).json({
      error: 'Failed to fetch experiences',
    });
  }
};
