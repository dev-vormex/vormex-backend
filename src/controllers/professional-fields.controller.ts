import { createHash } from 'crypto';
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma, prismaRead } from '../config/prisma';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { getProfileProjectLimitState } from '../services/tier-limits.service';
import { cacheService } from '../services/cache.service';
import { ensureString } from '../utils/request.util';
import { reindexPublicProfile } from '../services/public-discovery.service';

/**
 * Validation helpers
 */
const PROFICIENCY_LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
const EXPERIENCE_TYPES = ['Internship', 'Part-time', 'Full-time', 'Freelance', 'Contract'];
const ACHIEVEMENT_TYPES = ['Hackathon', 'Competition', 'Award', 'Scholarship', 'Recognition'];
const SKILL_SEARCH_CACHE_TTL_SECONDS = 5 * 60;
const SKILL_SEARCH_MAX_LIMIT = 20;

const skillSearchCacheKey = (query: string, limit: number): string =>
  `skills:search:v1:${createHash('sha256').update(query.toLowerCase()).digest('hex').slice(0, 24)}:${limit}`;

async function invalidateProfessionalProfileCaches(
  userId: string,
  refreshSearchDocument = false
): Promise<void> {
  await cacheService.invalidateTags(
    `user:${userId}`,
    `people:user:${userId}`,
    ...(refreshSearchDocument ? ['people:global'] : [])
  ).catch((error) => {
    console.warn('Professional profile cache invalidation failed:', error);
  });
  if (refreshSearchDocument) {
    void reindexPublicProfile(userId).catch(() => undefined);
  }
}

function validateUrl(url: string | null | undefined): boolean {
  if (!url) return true; // Optional field
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function validateDateRange(startDate: Date, endDate: Date | null | undefined, isCurrent: boolean): boolean {
  if (isCurrent || !endDate) return true;
  return startDate <= endDate;
}

// ============================================
// SKILLS
// ============================================

/**
 * Add skill to user profile
 * POST /api/users/me/skills
 */
export const addSkill = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { skillName, proficiency, yearsOfExp } = req.body;

    if (!skillName || typeof skillName !== 'string' || skillName.trim().length < 2) {
      res.status(400).json({ error: 'skillName is required and must be at least 2 characters' });
      return;
    }

    if (proficiency && !PROFICIENCY_LEVELS.includes(proficiency)) {
      res.status(400).json({
        error: `proficiency must be one of: ${PROFICIENCY_LEVELS.join(', ')}`,
      });
      return;
    }

    const existingUserSkill = await prisma.userSkill.findFirst({
      where: {
        userId,
        skill: {
          name: skillName.trim(),
        },
      },
      select: {
        id: true,
      },
    });

    // Find or create skill
    const skill = await prisma.skill.upsert({
      where: { name: skillName.trim() },
      create: { name: skillName.trim() },
      update: {},
    });

    // Create or update UserSkill
    const userSkill = await prisma.userSkill.upsert({
      where: {
        userId_skillId: {
          userId,
          skillId: skill.id,
        },
      },
      create: {
        userId,
        skillId: skill.id,
        proficiency: proficiency || null,
        yearsOfExp: yearsOfExp || null,
      },
      update: {
        proficiency: proficiency || null,
        yearsOfExp: yearsOfExp || null,
      },
      include: {
        skill: true,
      },
    });

    if (!existingUserSkill) {
      queueMatchAvailabilityNotifications(userId, 'skill_add');
    }
    await invalidateProfessionalProfileCaches(userId, true);

    res.status(201).json(userSkill);
  } catch (error) {
    console.error('Error adding skill:', error);
    res.status(500).json({
      error: 'Failed to add skill',
    });
  }
};

/**
 * Update user skill
 * PUT /api/users/me/skills/:id
 */
export const updateSkill = async (
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
      res.status(400).json({ error: 'Skill ID is required' });
      return;
    }
    const { proficiency, yearsOfExp } = req.body;

    // Verify ownership
    const userSkill = await prisma.userSkill.findUnique({
      where: { id },
    });

    if (!userSkill || userSkill.userId !== userId) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    if (proficiency && !PROFICIENCY_LEVELS.includes(proficiency)) {
      res.status(400).json({
        error: `proficiency must be one of: ${PROFICIENCY_LEVELS.join(', ')}`,
      });
      return;
    }

    const updated = await prisma.userSkill.update({
      where: { id },
      data: {
        proficiency: proficiency || null,
        yearsOfExp: yearsOfExp || null,
      },
      include: {
        skill: true,
      },
    });

    await invalidateProfessionalProfileCaches(userId);

    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating skill:', error);
    res.status(500).json({
      error: 'Failed to update skill',
    });
  }
};

/**
 * Delete user skill
 * DELETE /api/users/me/skills/:id
 */
export const deleteSkill = async (
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
      res.status(400).json({ error: 'Skill ID is required' });
      return;
    }

    // Verify ownership
    const userSkill = await prisma.userSkill.findUnique({
      where: { id },
    });

    if (!userSkill || userSkill.userId !== userId) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    await prisma.userSkill.delete({
      where: { id },
    });
    await invalidateProfessionalProfileCaches(userId, true);

    res.status(200).json({ message: 'Skill removed successfully' });
  } catch (error) {
    console.error('Error deleting skill:', error);
    res.status(500).json({
      error: 'Failed to delete skill',
    });
  }
};

/**
 * Search skills (autocomplete)
 * GET /api/skills/search?q=kotlin
 */
export const searchSkills = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const query = (ensureString(req.query.q) || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    const limit = Math.min(
      SKILL_SEARCH_MAX_LIMIT,
      Math.max(1, parseInt(ensureString(req.query.limit) || String(SKILL_SEARCH_MAX_LIMIT), 10) || SKILL_SEARCH_MAX_LIMIT)
    );

    if (query.length < 2) {
      res.status(200).json([]);
      return;
    }

    const cacheKey = skillSearchCacheKey(query, limit);
    const cached = await cacheService.get<any[]>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }

    const skills = await prismaRead.skill.findMany({
      where: {
        name: {
          contains: query,
          mode: 'insensitive',
        },
      },
      take: limit,
      orderBy: { name: 'asc' },
    });

    await cacheService.set(cacheKey, skills, SKILL_SEARCH_CACHE_TTL_SECONDS, ['people:filters']);

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(skills);
  } catch (error) {
    console.error('Error searching skills:', error);
    res.status(500).json({
      error: 'Failed to search skills',
    });
  }
};

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

    // StartDate is optional
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

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

// ============================================
// CERTIFICATES
// ============================================

/**
 * Create certificate
 * POST /api/users/me/certificates
 */
export const createCertificate = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { name, issuingOrg, issueDate, expiryDate, doesNotExpire, credentialId, credentialUrl } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 100) {
      res.status(400).json({ error: 'name is required and must be 2-100 characters' });
      return;
    }

    if (!issuingOrg || typeof issuingOrg !== 'string' || issuingOrg.trim().length < 2 || issuingOrg.length > 100) {
      res.status(400).json({ error: 'issuingOrg is required and must be 2-100 characters' });
      return;
    }

    if (!issueDate) {
      res.status(400).json({ error: 'issueDate is required' });
      return;
    }

    if (credentialUrl && !validateUrl(credentialUrl)) {
      res.status(400).json({ error: 'credentialUrl must be a valid URL' });
      return;
    }

    if (expiryDate && !doesNotExpire && new Date(expiryDate) <= new Date(issueDate)) {
      res.status(400).json({ error: 'expiryDate must be after issueDate' });
      return;
    }

    const certificate = await prisma.certificate.create({
      data: {
        userId,
        name: name.trim(),
        issuingOrg: issuingOrg.trim(),
        issueDate: new Date(issueDate),
        expiryDate: expiryDate && !doesNotExpire ? new Date(expiryDate) : null,
        doesNotExpire: doesNotExpire || false,
        credentialId: credentialId?.trim() || null,
        credentialUrl: credentialUrl || null,
      },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(201).json(certificate);
  } catch (error) {
    console.error('Error creating certificate:', error);
    res.status(500).json({
      error: 'Failed to create certificate',
    });
  }
};

/**
 * Update certificate
 * PUT /api/users/me/certificates/:id
 */
export const updateCertificate = async (
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
    const certificate = await prisma.certificate.findUnique({
      where: { id },
    });

    if (!certificate || certificate.userId !== userId) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    const updateData: any = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length < 2 || req.body.name.length > 100) {
        res.status(400).json({ error: 'name must be 2-100 characters' });
        return;
      }
      updateData.name = req.body.name.trim();
    }

    if (req.body.issuingOrg !== undefined) {
      if (typeof req.body.issuingOrg !== 'string' || req.body.issuingOrg.trim().length < 2 || req.body.issuingOrg.length > 100) {
        res.status(400).json({ error: 'issuingOrg must be 2-100 characters' });
        return;
      }
      updateData.issuingOrg = req.body.issuingOrg.trim();
    }

    if (req.body.issueDate !== undefined) {
      updateData.issueDate = new Date(req.body.issueDate);
    }

    if (req.body.expiryDate !== undefined) {
      updateData.expiryDate = req.body.expiryDate ? new Date(req.body.expiryDate) : null;
    }

    if (req.body.doesNotExpire !== undefined) {
      updateData.doesNotExpire = req.body.doesNotExpire;
    }

    if (req.body.credentialId !== undefined) {
      updateData.credentialId = req.body.credentialId?.trim() || null;
    }

    if (req.body.credentialUrl !== undefined) {
      if (req.body.credentialUrl && !validateUrl(req.body.credentialUrl)) {
        res.status(400).json({ error: 'credentialUrl must be a valid URL' });
        return;
      }
      updateData.credentialUrl = req.body.credentialUrl || null;
    }

    // Validate expiry date
    const issueDate = updateData.issueDate || certificate.issueDate;
    const expiryDate = updateData.expiryDate !== undefined ? updateData.expiryDate : certificate.expiryDate;
    const doesNotExpire = updateData.doesNotExpire !== undefined ? updateData.doesNotExpire : certificate.doesNotExpire;

    if (expiryDate && !doesNotExpire && expiryDate <= issueDate) {
      res.status(400).json({ error: 'expiryDate must be after issueDate' });
      return;
    }

    const updated = await prisma.certificate.update({
      where: { id },
      data: updateData,
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating certificate:', error);
    res.status(500).json({
      error: 'Failed to update certificate',
    });
  }
};

/**
 * Delete certificate
 * DELETE /api/users/me/certificates/:id
 */
export const deleteCertificate = async (
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
    const certificate = await prisma.certificate.findUnique({
      where: { id },
    });

    if (!certificate || certificate.userId !== userId) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    await prisma.certificate.delete({
      where: { id },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json({ message: 'Certificate deleted successfully' });
  } catch (error) {
    console.error('Error deleting certificate:', error);
    res.status(500).json({
      error: 'Failed to delete certificate',
    });
  }
};

/**
 * Get user certificates
 * GET /api/users/:userId/certificates
 */
export const getUserCertificates = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const certificates = await prisma.certificate.findMany({
      where: { userId },
      orderBy: { issueDate: 'desc' },
    });

    // Sort: valid (not expired) first, then by issueDate DESC
    const now = new Date();
    const sorted = certificates.sort((a, b) => {
      const aValid = a.doesNotExpire || !a.expiryDate || new Date(a.expiryDate) > now;
      const bValid = b.doesNotExpire || !b.expiryDate || new Date(b.expiryDate) > now;

      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return b.issueDate.getTime() - a.issueDate.getTime();
    });

    res.status(200).json(sorted);
  } catch (error) {
    console.error('Error getting certificates:', error);
    res.status(500).json({
      error: 'Failed to fetch certificates',
    });
  }
};

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

// ============================================
// INTERESTS
// ============================================

/**
 * Helper function to process and validate a single interest
 */
function processInterest(interest: string): string | null {
  const trimmed = interest.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return null;
  }
  // Capitalize first letter of each word
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Get user interests
 * GET /api/users/me/interests
 * Protected route
 */
export const getInterests = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    res.status(200).json({
      interests: user.interests || [],
    });
  } catch (error) {
    console.error('Error getting interests:', error);
    res.status(500).json({
      error: 'Failed to fetch interests',
    });
  }
};

/**
 * Add a new interest
 * POST /api/users/me/interests
 * Protected route
 */
export const addInterest = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const { interest } = req.body;

    if (!interest || typeof interest !== 'string') {
      res.status(400).json({
        error: 'Interest is required and must be a string',
      });
      return;
    }

    // Process the interest
    const processed = processInterest(interest);
    if (!processed) {
      res.status(400).json({
        error: 'Interest must be between 2 and 30 characters',
      });
      return;
    }

    // Get current interests
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const currentInterests = user.interests || [];

    // Check if already exists (case-insensitive)
    const exists = currentInterests.some(
      (i) => i.toLowerCase() === processed.toLowerCase()
    );

    if (exists) {
      res.status(409).json({
        error: 'Interest already exists',
      });
      return;
    }

    // Check max limit
    if (currentInterests.length >= 10) {
      res.status(400).json({
        error: 'Maximum 10 interests allowed',
      });
      return;
    }

    // Add new interest
    const updatedInterests = [...currentInterests, processed];

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { interests: updatedInterests },
      select: { interests: true },
    });

    queueMatchAvailabilityNotifications(userId, 'interest_add');
    await invalidateProfessionalProfileCaches(userId, true);

    res.status(201).json({
      interests: updatedUser.interests || [],
    });
  } catch (error) {
    console.error('Error adding interest:', error);
    res.status(500).json({
      error: 'Failed to add interest',
    });
  }
};

/**
 * Update an existing interest
 * PUT /api/users/me/interests/:interest
 * Protected route
 * Note: :interest is URL-encoded interest value
 */
export const updateInterest = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const oldInterest = decodeURIComponent(ensureString(req.params.interest) || '');
    const { interest: newInterest } = req.body;

    if (!newInterest || typeof newInterest !== 'string') {
      res.status(400).json({
        error: 'Interest is required and must be a string',
      });
      return;
    }

    // Process the new interest
    const processed = processInterest(newInterest);
    if (!processed) {
      res.status(400).json({
        error: 'Interest must be between 2 and 30 characters',
      });
      return;
    }

    // Get current interests
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const currentInterests = user.interests || [];

    // Find the index of the old interest (case-insensitive)
    const index = currentInterests.findIndex(
      (i) => i.toLowerCase() === oldInterest.toLowerCase()
    );

    if (index === -1) {
      res.status(404).json({
        error: 'Interest not found',
      });
      return;
    }

    // Check if new value already exists (excluding the one we're updating)
    const exists = currentInterests.some(
      (i, idx) => idx !== index && i.toLowerCase() === processed.toLowerCase()
    );

    if (exists) {
      res.status(409).json({
        error: 'Interest already exists',
      });
      return;
    }

    // Update the interest
    const updatedInterests = [...currentInterests];
    updatedInterests[index] = processed;

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { interests: updatedInterests },
      select: { interests: true },
    });

    queueMatchAvailabilityNotifications(userId, 'interest_update');
    await invalidateProfessionalProfileCaches(userId, true);

    res.status(200).json({
      interests: updatedUser.interests || [],
    });
  } catch (error) {
    console.error('Error updating interest:', error);
    res.status(500).json({
      error: 'Failed to update interest',
    });
  }
};

/**
 * Delete an interest
 * DELETE /api/users/me/interests/:interest
 * Protected route
 * Note: :interest is URL-encoded interest value
 */
export const deleteInterest = async (
  req: AuthenticatedRequest,
  res: Response<{ interests: string[] } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'Unauthorized',
      });
      return;
    }

    const userId = String(req.user.userId);
    const interestToDelete = decodeURIComponent(ensureString(req.params.interest) || '');

    // Get current interests
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { interests: true },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const currentInterests = user.interests || [];

    // Find and remove the interest (case-insensitive)
    const updatedInterests = currentInterests.filter(
      (i) => i.toLowerCase() !== interestToDelete.toLowerCase()
    );

    // Check if interest was found
    if (updatedInterests.length === currentInterests.length) {
      res.status(404).json({
        error: 'Interest not found',
      });
      return;
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { interests: updatedInterests },
      select: { interests: true },
    });

    await invalidateProfessionalProfileCaches(userId, true);

    res.status(200).json({
      interests: updatedUser.interests || [],
    });
  } catch (error) {
    console.error('Error deleting interest:', error);
    res.status(500).json({
      error: 'Failed to delete interest',
    });
  }
};
