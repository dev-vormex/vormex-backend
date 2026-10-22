import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { assertUsersCanInteract, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { notificationService } from "../../../notifications/services/notification.service";
import { normalizeSkillName, DEFAULT_SESSION_LENGTH, hydrateSkillSwapRows, skillSwapDisplayName } from "./support.controller";

export const createSkillSwapRequest = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const requesterId = req.user?.userId ? String(req.user.userId) : null;
    if (!requesterId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const recipientId = ensureString(req.body.recipientId);
    const skill = normalizeSkillName(req.body.skill);
    const message = (ensureString(req.body.message) || '').slice(0, 280) || null;
    const requesterGoal = (ensureString(req.body.requesterGoal) || '').slice(0, 140) || null;
    const mode = ensureString(req.body.mode) === 'teach' ? 'teach' : 'learn';
    const sessionLengthMinutes = Math.min(
      90,
      Math.max(15, Number(req.body.sessionLengthMinutes) || DEFAULT_SESSION_LENGTH)
    );
    const scheduledForRaw = ensureString(req.body.scheduledFor);
    const scheduledFor = scheduledForRaw ? new Date(scheduledForRaw) : null;

    if (!recipientId || !skill) {
      res.status(400).json({ error: 'Recipient and skill are required' });
      return;
    }
    if (recipientId === requesterId) {
      res.status(400).json({ error: 'You cannot request a swap with yourself' });
      return;
    }

    const [requester, recipient] = await Promise.all([
      prisma.user.findFirst({
        where: { id: requesterId, isBanned: false },
        select: { id: true, username: true, name: true },
      }),
      prisma.user.findFirst({
        where: { id: recipientId, isBanned: false },
        select: { id: true, username: true, name: true },
      }),
    ]);
    if (!recipient) {
      res.status(404).json({ error: 'Recipient not found' });
      return;
    }
    await assertUsersCanInteract(requesterId, recipientId, 'skill swap request');

    const existing = await prisma.skillSwapRequest.findFirst({
      where: {
        requesterId,
        recipientId,
        status: 'pending',
        skill: { equals: skill, mode: 'insensitive' },
      },
    });
    if (existing) {
      res.status(409).json({ error: 'A pending request already exists for this skill' });
      return;
    }

    const request = await prisma.skillSwapRequest.create({
      data: {
        requesterId,
        recipientId,
        skill,
        message,
        requesterGoal,
        mode,
        sessionLengthMinutes,
        scheduledFor: scheduledFor && !Number.isNaN(scheduledFor.getTime()) ? scheduledFor : null,
      },
    });

    const [hydrated] = await hydrateSkillSwapRows([request]);
    notificationService.notifySkillSwapRequest(recipientId, requesterId, {
      requesterName: skillSwapDisplayName(requester, 'A student'),
      requestId: request.id,
      skillName: request.skill,
      mode: request.mode,
      sessionLengthMinutes: request.sessionLengthMinutes,
    }).catch(() => undefined);
    res.status(201).json({ request: hydrated });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Error creating skill swap request:', error);
    res.status(500).json({ error: 'Failed to create skill swap request' });
  }
};

export const respondToSkillSwapRequest = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const requestId = ensureString(req.params.requestId);
    const action = (ensureString(req.body.action) || '').toLowerCase();
    if (!['accept', 'decline'].includes(action)) {
      res.status(400).json({ error: 'Action must be accept or decline' });
      return;
    }

    const request = await prisma.skillSwapRequest.findFirst({
      where: { id: requestId, recipientId: userId, status: 'pending' },
    });
    if (!request) {
      res.status(404).json({ error: 'Pending request not found' });
      return;
    }

    if (action === 'decline') {
      const updated = await prisma.skillSwapRequest.update({
        where: { id: request.id },
        data: { status: 'declined', respondedAt: new Date() },
      });
      const [hydrated] = await hydrateSkillSwapRows([updated]);
      res.json({ request: hydrated });
      return;
    }

    await assertUsersCanInteract(userId, request.requesterId, 'skill swap');

    const mentorId = request.mode === 'teach' ? request.requesterId : request.recipientId;
    const learnerId = request.mode === 'teach' ? request.recipientId : request.requesterId;
    const [updated, session] = await prisma.$transaction(async (tx) => {
      const accepted = await tx.skillSwapRequest.update({
        where: { id: request.id },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      const createdSession = await tx.skillSwapSession.create({
        data: {
          requestId: request.id,
          mentorId,
          learnerId,
          skill: request.skill,
          sessionLengthMinutes: request.sessionLengthMinutes,
          scheduledFor: request.scheduledFor,
        },
      });
      return [accepted, createdSession];
    });

    const [hydrated] = await hydrateSkillSwapRows([updated], [session]);
    notificationService.notifySkillSwapAccepted(request.requesterId, userId, {
      accepterName: skillSwapDisplayName(hydrated.recipient, 'A student'),
      requestId: request.id,
      sessionId: session.id,
      skillName: request.skill,
      sessionLengthMinutes: request.sessionLengthMinutes,
    }).catch(() => undefined);
    res.json({ request: hydrated, session: hydrated.session });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Error responding to skill swap request:', error);
    res.status(500).json({ error: 'Failed to respond to skill swap request' });
  }
};
