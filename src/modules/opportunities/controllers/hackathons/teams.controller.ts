import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { uniqueGroupSlug } from "../../../groups/services/group-slug.service";
import { cleanText, hydrateTeams, userCardSelect, cleanList, cleanOptionalText, notifySkillMatchesForTeam, formatApplication, formatHackathon } from "./support.controller";

export const formHackathonTeam = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const hackathonId = cleanText(req.params.hackathonId, 120);
    const hackathon = await prisma.hackathons.findFirst({ where: { id: hackathonId, isActive: true } });
    if (!hackathon) {
      res.status(404).json({ error: 'Hackathon not found' });
      return;
    }

    const existingTeam = await prisma.hackathon_teams.findFirst({
      where: { hackathonId, members: { some: { userId } } },
      include: { members: true, _count: { select: { members: true, applications: true } } },
    });
    if (existingTeam) {
      const [team] = await hydrateTeams([existingTeam], userId);
      res.json({ team, created: false });
      return;
    }

    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { ...userCardSelect, college: true },
    });
    if (!owner) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const teamName = cleanText(req.body.name, 90) || `${owner.name || 'My'} ${hackathon.title} team`;
    const groupId = randomUUID();
    const groupSlug = await uniqueGroupSlug(teamName);
    const maxMembers = Math.min(hackathon.teamMax || 4, Math.max(2, Number(req.body.maxMembers) || hackathon.teamMax || 4));
    const requiredSkills = cleanList(req.body.requiredSkills, 12, 48);
    const lookingForRoles = cleanList(req.body.lookingForRoles, 8, 48);

    const team = await prisma.$transaction(async (tx) => {
      await tx.groups.create({
        data: {
          id: groupId,
          name: teamName,
          slug: groupSlug,
          description: `Private team chat for ${hackathon.title}.`,
          imageUrl: hackathon.bannerUrl,
          creatorId: userId,
          isPrivate: true,
          memberCount: 1,
          maxMembers,
          tags: ['hackathon', hackathon.source, ...hackathon.tags.slice(0, 6)],
          updatedAt: new Date(),
          group_members: {
            create: {
              id: randomUUID(),
              userId,
              role: 'owner',
            },
          },
        },
      });

      const createdTeam = await tx.hackathon_teams.create({
        data: {
          hackathonId,
          ownerId: userId,
          groupId,
          name: teamName,
          pitch: cleanOptionalText(req.body.pitch, 600),
          lookingForRoles: lookingForRoles.length ? lookingForRoles : ['Frontend', 'Backend', 'Design', 'Pitch'],
          requiredSkills: requiredSkills.length ? requiredSkills : hackathon.skills.slice(0, 8),
          maxMembers,
          members: {
            create: {
              userId,
              role: 'owner',
              status: 'accepted',
            },
          },
        },
        include: { members: true, _count: { select: { members: true, applications: true } } },
      });

      return createdTeam;
    });

    notifySkillMatchesForTeam(team, hackathon, owner).catch(console.error);
    const [hydrated] = await hydrateTeams([team], userId);
    res.status(201).json({ team: hydrated, created: true });
  } catch (error) {
    console.error('formHackathonTeam error:', error);
    res.status(500).json({ error: 'Failed to form team' });
  }
};

export const listHackathonTeams = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const hackathonId = cleanText(req.params.hackathonId, 120);
    const teams = await prisma.hackathon_teams.findMany({
      where: { hackathonId },
      include: {
        members: { where: { status: 'accepted' }, orderBy: { joinedAt: 'asc' } },
        _count: { select: { members: true, applications: true } },
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 60,
    });
    res.json({ teams: await hydrateTeams(teams, userId) });
  } catch (error) {
    console.error('listHackathonTeams error:', error);
    res.status(500).json({ error: 'Failed to load teams' });
  }
};

export const getMyHackathonTeams = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [teams, applications] = await Promise.all([
      prisma.hackathon_teams.findMany({
        where: { members: { some: { userId } } },
        include: {
          hackathon: true,
          members: { where: { status: 'accepted' } },
          _count: { select: { members: true, applications: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      }),
      prisma.hackathon_team_applications.findMany({
        where: { applicantId: userId },
        include: {
          team: { include: { hackathon: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    res.json({
      teams: await hydrateTeams(teams, userId),
      applications: applications.map((application) => ({
        ...formatApplication(application),
        team: application.team ? {
          id: application.team.id,
          name: application.team.name,
          hackathon: application.team.hackathon ? formatHackathon(application.team.hackathon) : null,
        } : null,
      })),
    });
  } catch (error) {
    console.error('getMyHackathonTeams error:', error);
    res.status(500).json({ error: 'Failed to load your hackathon teams' });
  }
};
