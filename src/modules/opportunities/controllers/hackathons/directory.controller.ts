import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureExternalHackathonsAvailable } from "../../services/hackathon-import.service";
import { prisma } from "../../../../config/prisma";
import { cleanText, HACKATHON_SOURCES, formatHackathon } from "./support.controller";

export const listHackathons = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const now = new Date();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const status = cleanText(req.query.status, 24).toLowerCase();
    const search = cleanText(req.query.search || req.query.q, 120);
    const source = cleanText(req.query.source, 40).toLowerCase();
    const college = cleanText(req.query.college, 120);
    const skill = cleanText(req.query.skill, 80);
    const tag = cleanText(req.query.tag, 80);
    const savedOnly = req.query.saved === 'true';

    if (!savedOnly && page === 1 && !search && !college && !skill && !tag) {
      await ensureExternalHackathonsAvailable({ source, status, now });
    }

    const where: any = { isActive: true };
    if (!status || status === 'open') {
      where.endsAt = { gte: now };
    } else if (status === 'active') {
      where.startsAt = { lte: now };
      where.endsAt = { gte: now };
    } else if (status === 'upcoming') {
      where.startsAt = { gt: now };
    } else if (status === 'past') {
      where.endsAt = { lt: now };
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { organizer: { contains: search, mode: 'insensitive' } },
        { college: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (source && HACKATHON_SOURCES.has(source)) where.source = source;
    if (college) where.college = { contains: college, mode: 'insensitive' };
    if (skill) where.skills = { hasSome: [skill] };
    if (tag) where.tags = { hasSome: [tag] };
    if (savedOnly && userId) where.saves = { some: { userId } };

    const [hackathons, total] = await Promise.all([
      prisma.hackathons.findMany({
        where,
        include: { _count: { select: { teams: true, saves: true } } },
        orderBy: status === 'past'
          ? [{ endsAt: 'desc' }]
          : [{ registrationDeadline: 'asc' }, { startsAt: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.hackathons.count({ where }),
    ]);

    const hackathonIds = hackathons.map((hackathon) => hackathon.id);
    const [saves, userTeams] = userId && hackathonIds.length
      ? await Promise.all([
          prisma.hackathon_saves.findMany({
            where: { userId, hackathonId: { in: hackathonIds } },
            select: { hackathonId: true },
          }),
          prisma.hackathon_teams.findMany({
            where: {
              hackathonId: { in: hackathonIds },
              members: { some: { userId } },
            },
            include: { members: true, _count: { select: { members: true, applications: true } } },
          }),
        ])
      : [[], []];

    const savedIds = new Set(saves.map((save) => save.hackathonId));
    const userTeamByHackathon = new Map(userTeams.map((team) => [team.hackathonId, team]));

    res.json({
      hackathons: hackathons.map((hackathon) => formatHackathon(hackathon, { savedIds, userTeamByHackathon })),
      page,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  } catch (error) {
    console.error('listHackathons error:', error);
    res.status(500).json({ error: 'Failed to load hackathons' });
  }
};

export const getHackathon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const identifier = cleanText(req.params.identifier, 120);
    const hackathon = await prisma.hackathons.findFirst({
      where: { OR: [{ id: identifier }, { slug: identifier }], isActive: true },
      include: { _count: { select: { teams: true, saves: true } } },
    });
    if (!hackathon) {
      res.status(404).json({ error: 'Hackathon not found' });
      return;
    }

    const [save, userTeam] = userId
      ? await Promise.all([
          prisma.hackathon_saves.findUnique({
            where: { hackathonId_userId: { hackathonId: hackathon.id, userId } },
          }),
          prisma.hackathon_teams.findFirst({
            where: { hackathonId: hackathon.id, members: { some: { userId } } },
            include: { members: true, _count: { select: { members: true, applications: true } } },
          }),
        ])
      : [null, null];

    res.json({
      hackathon: formatHackathon(hackathon, {
        savedIds: save ? new Set([hackathon.id]) : new Set(),
        userTeamByHackathon: userTeam ? new Map([[hackathon.id, userTeam]]) : new Map(),
      }),
    });
  } catch (error) {
    console.error('getHackathon error:', error);
    res.status(500).json({ error: 'Failed to load hackathon' });
  }
};

export const saveHackathon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    await prisma.hackathon_saves.upsert({
      where: { hackathonId_userId: { hackathonId, userId } },
      create: { hackathonId, userId },
      update: {},
    });
    res.json({ saved: true });
  } catch (error) {
    console.error('saveHackathon error:', error);
    res.status(500).json({ error: 'Failed to save hackathon' });
  }
};

export const unsaveHackathon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const hackathonId = cleanText(req.params.hackathonId, 120);
    await prisma.hackathon_saves.deleteMany({ where: { hackathonId, userId } });
    res.json({ saved: false });
  } catch (error) {
    console.error('unsaveHackathon error:', error);
    res.status(500).json({ error: 'Failed to unsave hackathon' });
  }
};
