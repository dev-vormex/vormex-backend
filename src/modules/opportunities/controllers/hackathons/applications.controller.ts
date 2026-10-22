import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { getHackathonTeamApplicationLimitState } from "../../../safety/services/tier-limits.service";
import { notificationService } from "../../../notifications/services/notification.service";
import { randomUUID } from "crypto";
import { cleanText, TEAM_STATUS_OPEN, cleanOptionalText, cleanList, userCardSelect, formatApplication, TEAM_STATUS_FULL } from "./support.controller";

export const applyToHackathonTeam = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const teamId = cleanText(req.params.teamId, 120);
    const team = await prisma.hackathon_teams.findUnique({
      where: { id: teamId },
      include: {
        hackathon: true,
        members: { where: { status: 'accepted' } },
      },
    });
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }
    if (team.ownerId === userId || team.members.some((member) => member.userId === userId)) {
      res.status(400).json({ error: 'You are already on this team' });
      return;
    }
    if (team.status !== TEAM_STATUS_OPEN || team.members.length >= team.maxMembers) {
      res.status(409).json({ error: 'This team is already full' });
      return;
    }

    const limitState = await getHackathonTeamApplicationLimitState(userId);
    if (!limitState.allowed) {
      res.status(403).json({
        error: 'Free accounts can apply to 3 hackathon teams per month. Upgrade to Premium for unlimited applications.',
        code: 'hackathon_application_limit_reached',
        limit: limitState.limit,
        used: limitState.used,
        remaining: limitState.remaining,
      });
      return;
    }

    const existing = await prisma.hackathon_team_applications.findUnique({
      where: { teamId_applicantId: { teamId, applicantId: userId } },
    });
    if (existing?.status === 'pending') {
      res.status(409).json({ error: 'You already applied to this team' });
      return;
    }
    if (existing?.status === 'accepted') {
      res.status(409).json({ error: 'You are already accepted into this team' });
      return;
    }

    const application = existing
      ? await prisma.hackathon_team_applications.update({
          where: { id: existing.id },
          data: {
            status: 'pending',
            respondedAt: null,
            role: cleanOptionalText(req.body.role, 80),
            message: cleanOptionalText(req.body.message, 500),
            skills: cleanList(req.body.skills, 10, 48),
          },
        })
      : await prisma.hackathon_team_applications.create({
          data: {
            teamId,
            applicantId: userId,
            role: cleanOptionalText(req.body.role, 80),
            message: cleanOptionalText(req.body.message, 500),
            skills: cleanList(req.body.skills, 10, 48),
          },
        });

    const applicant = await prisma.user.findUnique({ where: { id: userId }, select: userCardSelect });
    notificationService.notifyHackathonTeamApplication(team.ownerId, userId, {
      applicantName: applicant?.name || 'Someone',
      hackathonTitle: team.hackathon.title,
      teamId,
      hackathonId: team.hackathonId,
      applicationId: application.id,
    }).catch(console.error);

    res.status(201).json({ application: formatApplication(application, new Map([[userId, applicant]])) });
  } catch (error) {
    console.error('applyToHackathonTeam error:', error);
    res.status(500).json({ error: 'Failed to apply to team' });
  }
};

export const respondToHackathonTeamApplication = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const applicationId = cleanText(req.params.applicationId, 120);
    const action = cleanText(req.body.action, 24).toLowerCase();
    if (!['accept', 'reject'].includes(action)) {
      res.status(400).json({ error: 'Action must be accept or reject' });
      return;
    }

    const application = await prisma.hackathon_team_applications.findUnique({
      where: { id: applicationId },
      include: {
        team: {
          include: {
            hackathon: true,
            members: { where: { status: 'accepted' } },
          },
        },
      },
    });
    if (!application || application.status !== 'pending') {
      res.status(404).json({ error: 'Pending application not found' });
      return;
    }
    if (application.team.ownerId !== userId) {
      res.status(403).json({ error: 'Only the team owner can respond' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      if (action === 'reject') {
        return tx.hackathon_team_applications.update({
          where: { id: application.id },
          data: { status: 'rejected', respondedAt: new Date() },
        });
      }

      if (application.team.members.length >= application.team.maxMembers) {
        throw new Error('TEAM_FULL');
      }

      const updatedApplication = await tx.hackathon_team_applications.update({
        where: { id: application.id },
        data: { status: 'accepted', respondedAt: new Date() },
      });

      await tx.hackathon_team_members.upsert({
        where: { teamId_userId: { teamId: application.teamId, userId: application.applicantId } },
        create: {
          teamId: application.teamId,
          userId: application.applicantId,
          role: application.role || 'member',
          status: 'accepted',
        },
        update: {
          role: application.role || 'member',
          status: 'accepted',
        },
      });

      if (application.team.groupId) {
        await tx.group_members.upsert({
          where: { groupId_userId: { groupId: application.team.groupId, userId: application.applicantId } },
          create: {
            id: randomUUID(),
            groupId: application.team.groupId,
            userId: application.applicantId,
            role: 'member',
          },
          update: { role: 'member' },
        });
        await tx.groups.update({
          where: { id: application.team.groupId },
          data: { memberCount: { increment: 1 } },
        }).catch(() => null);
      }

      const nextMemberCount = application.team.members.length + 1;
      if (nextMemberCount >= application.team.maxMembers) {
        await tx.hackathon_teams.update({
          where: { id: application.teamId },
          data: { status: TEAM_STATUS_FULL },
        });
      }

      return updatedApplication;
    });

    if (action === 'accept') {
      notificationService.notifyHackathonTeamApplicationAccepted(application.applicantId, userId, {
        hackathonTitle: application.team.hackathon.title,
        teamId: application.teamId,
        hackathonId: application.team.hackathonId,
        groupId: application.team.groupId,
      }).catch(console.error);
    }

    const applicant = await prisma.user.findUnique({ where: { id: application.applicantId }, select: userCardSelect });
    res.json({ application: formatApplication(result, new Map([[application.applicantId, applicant]])) });
  } catch (error) {
    console.error('respondToHackathonTeamApplication error:', error);
    const message = error instanceof Error && error.message === 'TEAM_FULL'
      ? 'This team is already full'
      : 'Failed to respond to application';
    res.status(message.includes('full') ? 409 : 500).json({ error: message });
  }
};
