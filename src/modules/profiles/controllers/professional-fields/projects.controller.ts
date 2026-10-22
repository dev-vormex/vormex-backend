import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getProfileProjectLimitState } from "../../../safety/services/tier-limits.service";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { validateDateRange, validateUrl, invalidateProfessionalProfileCaches } from "./support.controller";

// ============================================
// PROJECTS
// ============================================

/**
 * Create project
 * POST /api/users/me/projects
 */
export const createProject = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { name, description, role, techStack, startDate, endDate, isCurrent, projectUrl, githubUrl, otherLinks, images, featured } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 100) {
      res.status(400).json({ error: 'name is required and must be 2-100 characters' });
      return;
    }

    // Description is optional but if provided must be 10-2000 characters
    if (description && (typeof description !== 'string' || description.trim().length < 10 || description.length > 2000)) {
      res.status(400).json({ error: 'description must be 10-2000 characters if provided' });
      return;
    }

    if (!startDate) {
      res.status(400).json({ error: 'startDate is required' });
      return;
    }
    const start = new Date(startDate);
    if (!Number.isFinite(start.getTime())) {
      res.status(400).json({ error: 'startDate must be a valid date' });
      return;
    }
    const end = endDate ? new Date(endDate) : null;
    if (end && !Number.isFinite(end.getTime())) {
      res.status(400).json({ error: 'endDate must be a valid date' });
      return;
    }

    if (start && end && !validateDateRange(start, end, isCurrent)) {
      res.status(400).json({ error: 'startDate must be before endDate' });
      return;
    }

    if (projectUrl && !validateUrl(projectUrl)) {
      res.status(400).json({ error: 'projectUrl must be a valid URL' });
      return;
    }

    if (githubUrl && !validateUrl(githubUrl)) {
      res.status(400).json({ error: 'githubUrl must be a valid URL' });
      return;
    }

    const limitState = await getProfileProjectLimitState(userId);
    if (!limitState.allowed) {
      res.status(403).json({
        error: limitState.isPremium
          ? 'Premium profiles can showcase up to 10 projects.'
          : 'Free profiles can showcase up to 3 projects. Upgrade to Premium to add up to 10 projects.',
        code: 'profile_project_limit_reached',
        limit: limitState.limit,
        used: limitState.used,
        remaining: limitState.remaining,
      });
      return;
    }

    const project = await prisma.project.create({
      data: {
        userId,
        name: name.trim(),
        description: description?.trim() || '',
        role: role?.trim() || null,
        techStack: Array.isArray(techStack) ? techStack : [],
        startDate: start,
        endDate: end,
        isCurrent: isCurrent || false,
        projectUrl: projectUrl || null,
        githubUrl: githubUrl || null,
        otherLinks: otherLinks || null,
        images: Array.isArray(images) ? images : [],
        featured: featured || false,
      },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(201).json(project);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({
      error: 'Failed to create project',
    });
  }
};

/**
 * Update project
 * PUT /api/users/me/projects/:id
 */
export const updateProject = async (
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
    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project || project.userId !== userId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const updateData: any = {};

    // Build update data with validation
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length < 2 || req.body.name.length > 100) {
        res.status(400).json({ error: 'name must be 2-100 characters' });
        return;
      }
      updateData.name = req.body.name.trim();
    }

    if (req.body.description !== undefined) {
      // Description can be empty string or if provided must be 10-2000 characters
      if (req.body.description && req.body.description.trim().length > 0) {
        if (typeof req.body.description !== 'string' || req.body.description.trim().length < 10 || req.body.description.length > 2000) {
          res.status(400).json({ error: 'description must be 10-2000 characters if provided' });
          return;
        }
        updateData.description = req.body.description.trim();
      } else {
        updateData.description = '';
      }
    }

    if (req.body.role !== undefined) {
      updateData.role = req.body.role?.trim() || null;
    }

    if (req.body.techStack !== undefined) {
      updateData.techStack = Array.isArray(req.body.techStack) ? req.body.techStack : [];
    }

    if (req.body.startDate !== undefined) {
      updateData.startDate = req.body.startDate ? new Date(req.body.startDate) : null;
    }

    if (req.body.endDate !== undefined) {
      updateData.endDate = req.body.endDate ? new Date(req.body.endDate) : null;
    }

    if (req.body.isCurrent !== undefined) {
      updateData.isCurrent = req.body.isCurrent;
    }

    if (req.body.projectUrl !== undefined) {
      if (req.body.projectUrl && !validateUrl(req.body.projectUrl)) {
        res.status(400).json({ error: 'projectUrl must be a valid URL' });
        return;
      }
      updateData.projectUrl = req.body.projectUrl || null;
    }

    if (req.body.githubUrl !== undefined) {
      if (req.body.githubUrl && !validateUrl(req.body.githubUrl)) {
        res.status(400).json({ error: 'githubUrl must be a valid URL' });
        return;
      }
      updateData.githubUrl = req.body.githubUrl || null;
    }

    if (req.body.otherLinks !== undefined) {
      updateData.otherLinks = req.body.otherLinks || null;
    }

    if (req.body.images !== undefined) {
      updateData.images = Array.isArray(req.body.images) ? req.body.images : [];
    }

    if (req.body.featured !== undefined) {
      updateData.featured = req.body.featured;
    }

    // Validate date range (only if both dates exist)
    const startDate = updateData.startDate !== undefined ? updateData.startDate : project.startDate;
    const endDate = updateData.endDate !== undefined ? updateData.endDate : project.endDate;
    const isCurrent = updateData.isCurrent !== undefined ? updateData.isCurrent : project.isCurrent;

    if (startDate && endDate && !validateDateRange(startDate, endDate, isCurrent)) {
      res.status(400).json({ error: 'startDate must be before endDate' });
      return;
    }

    const updated = await prisma.project.update({
      where: { id },
      data: updateData,
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({
      error: 'Failed to update project',
    });
  }
};

/**
 * Delete project
 * DELETE /api/users/me/projects/:id
 */
export const deleteProject = async (
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
    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project || project.userId !== userId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await prisma.project.delete({
      where: { id },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      error: 'Failed to delete project',
    });
  }
};

/**
 * Feature/unfeature project
 * POST /api/users/me/projects/:id/feature
 */
export const featureProject = async (
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
    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project || project.userId !== userId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const newFeaturedStatus = !project.featured;

    // If trying to feature, check limit (max 3)
    if (newFeaturedStatus) {
      const featuredCount = await prisma.project.count({
        where: {
          userId,
          featured: true,
        },
      });

      if (featuredCount >= 3) {
        res.status(400).json({
          error: 'Maximum 3 projects can be featured. Unfeature another project first.',
        });
        return;
      }
    }

    const updated = await prisma.project.update({
      where: { id },
      data: { featured: newFeaturedStatus },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error featuring project:', error);
    res.status(500).json({
      error: 'Failed to update project feature status',
    });
  }
};

/**
 * Get user projects
 * GET /api/users/:userId/projects
 */
export const getUserProjects = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const projects = await prisma.project.findMany({
      where: { userId },
      orderBy: [
        { featured: 'desc' },
        { startDate: 'desc' },
      ],
    });

    res.status(200).json(projects);
  } catch (error) {
    console.error('Error getting projects:', error);
    res.status(500).json({
      error: 'Failed to fetch projects',
    });
  }
};
