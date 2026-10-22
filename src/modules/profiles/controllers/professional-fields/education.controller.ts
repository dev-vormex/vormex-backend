import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { validateDateRange, validateUrl, invalidateProfessionalProfileCaches } from "./support.controller";

// ============================================
// EDUCATION
// ============================================

/**
 * Create education
 * POST /api/users/me/education
 */
export const createEducation = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { school, degree, fieldOfStudy, startDate, endDate, isCurrent, grade, activities, description, logo } = req.body;

    // Validation
    if (!school || typeof school !== 'string' || school.trim().length < 2 || school.length > 100) {
      res.status(400).json({ error: 'school is required and must be 2-100 characters' });
      return;
    }

    if (!degree || typeof degree !== 'string' || degree.trim().length < 2 || degree.length > 100) {
      res.status(400).json({ error: 'degree is required and must be 2-100 characters' });
      return;
    }

    if (!fieldOfStudy || typeof fieldOfStudy !== 'string' || fieldOfStudy.trim().length < 2 || fieldOfStudy.length > 100) {
      res.status(400).json({ error: 'fieldOfStudy is required and must be 2-100 characters' });
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

    if (activities && activities.length > 2000) {
      res.status(400).json({ error: 'activities must be 2000 characters or less' });
      return;
    }

    if (logo && (typeof logo !== 'string' || !validateUrl(logo))) {
      res.status(400).json({ error: 'logo must be a valid URL' });
      return;
    }

    const education = await prisma.education.create({
      data: {
        userId,
        school: school.trim(),
        degree: degree.trim(),
        fieldOfStudy: fieldOfStudy.trim(),
        startDate: start,
        endDate: end,
        isCurrent: isCurrent || false,
        grade: grade?.trim() || null,
        activities: activities?.trim() || null,
        description: description?.trim() || null,
        logo: logo || null,
      },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(201).json(education);
  } catch (error) {
    console.error('Error creating education:', error);
    res.status(500).json({
      error: 'Failed to create education',
    });
  }
};

/**
 * Update education
 * PUT /api/users/me/education/:id
 */
export const updateEducation = async (
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
    const education = await prisma.education.findUnique({
      where: { id },
    });

    if (!education || education.userId !== userId) {
      res.status(404).json({ error: 'Education not found' });
      return;
    }

    const updateData: any = {};

    // Build update data with validation
    if (req.body.school !== undefined) {
      if (typeof req.body.school !== 'string' || req.body.school.trim().length < 2 || req.body.school.length > 100) {
        res.status(400).json({ error: 'school must be 2-100 characters' });
        return;
      }
      updateData.school = req.body.school.trim();
    }

    if (req.body.degree !== undefined) {
      if (typeof req.body.degree !== 'string' || req.body.degree.trim().length < 2 || req.body.degree.length > 100) {
        res.status(400).json({ error: 'degree must be 2-100 characters' });
        return;
      }
      updateData.degree = req.body.degree.trim();
    }

    if (req.body.fieldOfStudy !== undefined) {
      if (typeof req.body.fieldOfStudy !== 'string' || req.body.fieldOfStudy.trim().length < 2 || req.body.fieldOfStudy.length > 100) {
        res.status(400).json({ error: 'fieldOfStudy must be 2-100 characters' });
        return;
      }
      updateData.fieldOfStudy = req.body.fieldOfStudy.trim();
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

    if (req.body.grade !== undefined) {
      updateData.grade = req.body.grade?.trim() || null;
    }

    if (req.body.activities !== undefined) {
      if (req.body.activities && req.body.activities.length > 2000) {
        res.status(400).json({ error: 'activities must be 2000 characters or less' });
        return;
      }
      updateData.activities = req.body.activities?.trim() || null;
    }

    if (req.body.description !== undefined) {
      if (req.body.description && req.body.description.length > 2000) {
        res.status(400).json({ error: 'description must be 2000 characters or less' });
        return;
      }
      updateData.description = req.body.description?.trim() || null;
    }

    if (req.body.logo !== undefined) {
      if (req.body.logo && (typeof req.body.logo !== 'string' || !validateUrl(req.body.logo))) {
        res.status(400).json({ error: 'logo must be a valid URL' });
        return;
      }
      updateData.logo = req.body.logo || null;
    }

    // Validate date range
    const startDate = updateData.startDate || education.startDate;
    const endDate = updateData.endDate !== undefined ? updateData.endDate : education.endDate;
    const isCurrent = updateData.isCurrent !== undefined ? updateData.isCurrent : education.isCurrent;

    if (!validateDateRange(startDate, endDate, isCurrent)) {
      res.status(400).json({ error: 'startDate must be before endDate' });
      return;
    }

    const updated = await prisma.education.update({
      where: { id },
      data: updateData,
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating education:', error);
    res.status(500).json({
      error: 'Failed to update education',
    });
  }
};

/**
 * Delete education
 * DELETE /api/users/me/education/:id
 */
export const deleteEducation = async (
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
    const education = await prisma.education.findUnique({
      where: { id },
    });

    if (!education || education.userId !== userId) {
      res.status(404).json({ error: 'Education not found' });
      return;
    }

    await prisma.education.delete({
      where: { id },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json({ message: 'Education deleted successfully' });
  } catch (error) {
    console.error('Error deleting education:', error);
    res.status(500).json({
      error: 'Failed to delete education',
    });
  }
};

/**
 * Get user education
 * GET /api/users/:userId/education
 */
export const getUserEducation = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const education = await prisma.education.findMany({
      where: { userId },
      orderBy: [
        { isCurrent: 'desc' },
        { startDate: 'desc' },
      ],
    });

    res.status(200).json(education);
  } catch (error) {
    console.error('Error getting education:', error);
    res.status(500).json({
      error: 'Failed to fetch education',
    });
  }
};
