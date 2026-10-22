import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma, prismaRead } from "../../../../config/prisma";
import { queueMatchAvailabilityNotifications } from "../../../notifications/services/match-availability-notification.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { PROFICIENCY_LEVELS, invalidateProfessionalProfileCaches, SKILL_SEARCH_MAX_LIMIT, skillSearchCacheKey, SKILL_SEARCH_CACHE_TTL_SECONDS } from "./support.controller";

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
