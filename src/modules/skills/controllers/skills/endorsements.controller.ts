import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { assertUsersCanInteract, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { notificationService } from "../../../notifications/services/notification.service";
import { normalizeSkillName, userCardSelect, areConnected, findOrCreateSkill, formatUserCard, normalizeProvider, providerProfileUrl } from "./support.controller";

export const endorseSkill = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const endorserId = req.user?.userId ? String(req.user.userId) : null;
    if (!endorserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const targetUserId = ensureString(req.params.userId);
    const skillName = normalizeSkillName(req.body.skillName);
    const note = (ensureString(req.body.note) || '').slice(0, 240) || null;
    const rating = req.body.rating === undefined
      ? null
      : Math.min(5, Math.max(1, Number(req.body.rating) || 5));

    if (!targetUserId || !skillName) {
      res.status(400).json({ error: 'Target user and skillName are required' });
      return;
    }
    if (targetUserId === endorserId) {
      res.status(400).json({ error: 'You cannot endorse yourself' });
      return;
    }

    const [target, endorser, connected] = await Promise.all([
      prisma.user.findFirst({ where: { id: targetUserId, isBanned: false }, select: userCardSelect }),
      prisma.user.findUnique({ where: { id: endorserId }, select: userCardSelect }),
      areConnected(endorserId, targetUserId),
    ]);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    await assertUsersCanInteract(endorserId, targetUserId, 'endorsement');
    if (!connected) {
      res.status(403).json({
        error: 'You can endorse skills only for connected users.',
        code: 'connection_required_for_endorsement',
      });
      return;
    }

    const skill = await findOrCreateSkill(skillName);
    const existing = await prisma.skillEndorsement.findFirst({
      where: {
        userId: targetUserId,
        endorsedById: endorserId,
        skillName: { equals: skill.name, mode: 'insensitive' },
        source: 'manual',
      },
    });

    const endorsement = existing
      ? await prisma.skillEndorsement.update({
          where: { id: existing.id },
          data: { note, rating, skillId: skill.id, skillName: skill.name },
        })
      : await prisma.skillEndorsement.create({
          data: {
            userId: targetUserId,
            endorsedById: endorserId,
            skillId: skill.id,
            skillName: skill.name,
            source: 'manual',
            note,
            rating,
          },
        });

    await prisma.userSkill.upsert({
      where: { userId_skillId: { userId: targetUserId, skillId: skill.id } },
      create: { userId: targetUserId, skillId: skill.id, proficiency: null, yearsOfExp: null },
      update: {},
    }).catch(() => null);

    notificationService.notifySkillEndorsement(targetUserId, endorserId, {
      endorserName: endorser?.name || 'Someone',
      skillName: skill.name,
      endorsementId: endorsement.id,
    }).catch(console.error);

    res.status(existing ? 200 : 201).json({
      endorsement: {
        id: endorsement.id,
        skillName: endorsement.skillName,
        note: endorsement.note,
        rating: endorsement.rating,
        source: endorsement.source,
        createdAt: endorsement.createdAt?.toISOString?.() ?? null,
        endorsedBy: formatUserCard(endorser),
      },
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Error endorsing skill:', error);
    res.status(500).json({ error: 'Failed to endorse skill' });
  }
};

export const upsertSkillVerificationLink = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const provider = normalizeProvider(req.body.provider);
    const username = normalizeSkillName(req.body.username);
    const rawProfileUrl = (ensureString(req.body.profileUrl) || '').slice(0, 500) || null;
    if (!provider || !username) {
      res.status(400).json({ error: 'provider must be github, leetcode, or portfolio, and username is required' });
      return;
    }

    const profileUrl = providerProfileUrl(provider, username, rawProfileUrl);
    const link = await prisma.skillVerificationLink.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        username,
        profileUrl,
        status: 'verified',
        verifiedAt: new Date(),
        metadata: {
          autoVerified: true,
          source: 'profile_link',
        },
      },
      update: {
        username,
        profileUrl,
        status: 'verified',
        verifiedAt: new Date(),
        metadata: {
          autoVerified: true,
          source: 'profile_link',
        },
      },
    });

    if (provider === 'github') {
      await prisma.user.update({
        where: { id: userId },
        data: {
          githubConnected: true,
          githubUsername: username,
          githubProfileUrl: profileUrl,
        },
      }).catch(() => null);
    }

    res.json({
      verificationLink: {
        id: link.id,
        provider: link.provider,
        username: link.username,
        profileUrl: link.profileUrl,
        status: link.status,
        verifiedAt: link.verifiedAt?.toISOString?.() ?? null,
        createdAt: link.createdAt.toISOString(),
        updatedAt: link.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Error upserting skill verification link:', error);
    res.status(500).json({ error: 'Failed to link skill verification profile' });
  }
};

export const deleteSkillVerificationLink = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const provider = normalizeProvider(req.params.provider);
    if (!provider) {
      res.status(400).json({ error: 'Invalid provider' });
      return;
    }

    await prisma.skillVerificationLink.deleteMany({ where: { userId, provider } });
    res.json({ deleted: true });
  } catch (error) {
    console.error('Error deleting skill verification link:', error);
    res.status(500).json({ error: 'Failed to delete skill verification profile' });
  }
};
