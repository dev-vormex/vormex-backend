import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { notificationService } from "../../../notifications/services/notification.service";
import { findOrCreateSkill, userCardSelect, skillSwapDisplayName, formatSession } from "./support.controller";

export const completeSkillSwapSession = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = ensureString(req.params.sessionId);
    const rating = Math.min(5, Math.max(1, Number(req.body.rating) || 5));
    const note = (ensureString(req.body.note) || '').slice(0, 240) || null;
    const endorseSkill = req.body.endorseSkill !== false;

    const session = await prisma.skillSwapSession.findFirst({
      where: {
        id: sessionId,
        OR: [{ mentorId: userId }, { learnerId: userId }],
      },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const isLearner = session.learnerId === userId;
    const endorsedUserId = isLearner ? session.mentorId : session.learnerId;
    const data = {
      status: 'completed',
      completedAt: session.completedAt || new Date(),
      ...(isLearner
        ? { learnerRating: rating, learnerNote: note }
        : { mentorRating: rating, mentorNote: note }),
    };

    const updated = await prisma.skillSwapSession.update({
      where: { id: session.id },
      data,
    });

    let endorsement = null;
    if (endorseSkill) {
      const skill = await findOrCreateSkill(session.skill);
      const existing = await prisma.skillEndorsement.findFirst({
        where: {
          userId: endorsedUserId,
          endorsedById: userId,
          source: 'skill_swap',
          sourceId: session.id,
        },
      });
      endorsement = existing || await prisma.skillEndorsement.create({
        data: {
          userId: endorsedUserId,
          endorsedById: userId,
          skillId: skill.id,
          skillName: skill.name,
          source: 'skill_swap',
          sourceId: session.id,
          note,
          rating,
        },
      });
    }

    const users = await prisma.user.findMany({
      where: { id: { in: [updated.mentorId, updated.learnerId] } },
      select: userCardSelect,
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    notificationService.notifySkillSwapCompleted(endorsedUserId, userId, {
      actorName: skillSwapDisplayName(userById.get(userId), 'A student'),
      sessionId: updated.id,
      requestId: updated.requestId,
      skillName: updated.skill,
    }).catch(() => undefined);
    res.json({
      session: formatSession(updated, userById),
      endorsement,
    });
  } catch (error) {
    console.error('Error completing skill swap session:', error);
    res.status(500).json({ error: 'Failed to complete skill swap session' });
  }
};
