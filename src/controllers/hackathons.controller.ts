// @ts-nocheck
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { ensureString } from '../utils/request.util';
import { notificationService } from '../services/notification.service';
import { getHackathonTeamApplicationLimitState } from '../services/tier-limits.service';
import { importExternalHackathons } from '../services/hackathon-import.service';

const HACKATHON_SOURCES = new Set(['devfolio', 'mlh', 'college_fest', 'custom']);
const TEAM_STATUS_OPEN = 'open';
const TEAM_STATUS_FULL = 'full';

const userCardSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  college: true,
  branch: true,
  graduationYear: true,
  isOnline: true,
  lastActiveAt: true,
};

function cleanText(value: unknown, max = 240): string {
  return (ensureString(value) || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanOptionalText(value: unknown, max = 240): string | null {
  const text = cleanText(value, max);
  return text || null;
}

function cleanList(value: unknown, maxItems = 12, maxLen = 48): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((item) => {
    const normalized = cleanText(item, maxLen);
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  });
  return result.slice(0, maxItems);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || randomUUID().slice(0, 8);
}

async function uniqueHackathonSlug(title: string, startsAt: Date): Promise<string> {
  const base = slugify(`${title}-${startsAt.getUTCFullYear()}`);
  let slug = base;
  let suffix = 2;
  while (await prisma.hackathons.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

async function uniqueGroupSlug(name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  let suffix = 2;
  while (await prisma.groups.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function parseRequiredDate(value: unknown, label: string): Date {
  const date = new Date(ensureString(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function parseOptionalDate(value: unknown): Date | null {
  const raw = ensureString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function computedHackathonStatus(hackathon: any, now = new Date()): string {
  if (!hackathon.isActive) return 'archived';
  if (hackathon.endsAt < now) return 'past';
  if (hackathon.startsAt > now) return 'upcoming';
  return 'active';
}

function formatUser(user: any) {
  if (!user) return null;
  return {
    ...user,
    isOnline: Boolean(user.isOnline),
    lastActiveAt: user.lastActiveAt?.toISOString?.() ?? user.lastActiveAt ?? null,
  };
}

function formatHackathon(row: any, context: { savedIds?: Set<string>; userTeamByHackathon?: Map<string, any> } = {}) {
  const teamCount = row._count?.teams ?? row.teamsCount ?? 0;
  const savedCount = row._count?.saves ?? row.savesCount ?? 0;
  const userTeam = context.userTeamByHackathon?.get(row.id) || null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    organizer: row.organizer,
    source: row.source,
    sourceUrl: row.sourceUrl,
    sourceId: row.sourceId,
    college: row.college,
    description: row.description,
    theme: row.theme,
    location: row.location,
    isOnline: row.isOnline,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    registrationDeadline: row.registrationDeadline?.toISOString?.() ?? null,
    teamMin: row.teamMin,
    teamMax: row.teamMax,
    prizeSummary: row.prizeSummary,
    tags: row.tags,
    skills: row.skills,
    bannerUrl: row.bannerUrl,
    status: computedHackathonStatus(row),
    teamsCount: teamCount,
    savesCount: savedCount,
    isSaved: context.savedIds?.has(row.id) || false,
    myTeam: userTeam ? formatTeam(userTeam) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatTeam(row: any, usersById?: Map<string, any>, applicationByTeam?: Map<string, any>) {
  const members = (row.members || row.hackathon_team_members || []).map((member: any) => ({
    id: member.id,
    userId: member.userId,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt?.toISOString?.() ?? null,
    user: formatUser(usersById?.get(member.userId)),
  }));
  const owner = usersById?.get(row.ownerId);
  const pendingApplication = applicationByTeam?.get(row.id);

  return {
    id: row.id,
    hackathonId: row.hackathonId,
    ownerId: row.ownerId,
    owner: formatUser(owner),
    groupId: row.groupId,
    name: row.name,
    pitch: row.pitch,
    lookingForRoles: row.lookingForRoles,
    requiredSkills: row.requiredSkills,
    maxMembers: row.maxMembers,
    status: row.status,
    memberCount: row._count?.members ?? members.length,
    pendingApplicationsCount: row._count?.applications ?? 0,
    members,
    myApplication: pendingApplication ? formatApplication(pendingApplication, usersById) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function formatApplication(row: any, usersById?: Map<string, any>) {
  return {
    id: row.id,
    teamId: row.teamId,
    applicantId: row.applicantId,
    applicant: formatUser(usersById?.get(row.applicantId)),
    role: row.role,
    message: row.message,
    skills: row.skills,
    status: row.status,
    respondedAt: row.respondedAt?.toISOString?.() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function hydrateTeams(teams: any[], currentUserId?: string | null) {
  const userIds = Array.from(new Set(teams.flatMap((team) => [
    team.ownerId,
    ...(team.members || []).map((member: any) => member.userId),
    ...(team.applications || []).map((application: any) => application.applicantId),
  ]).filter(Boolean)));
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: userCardSelect })
    : [];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const myApplications = currentUserId
    ? await prisma.hackathon_team_applications.findMany({
        where: { applicantId: currentUserId, teamId: { in: teams.map((team) => team.id) } },
      })
    : [];
  const applicationByTeam = new Map(myApplications.map((application) => [application.teamId, application]));
  return teams.map((team) => formatTeam(team, usersById, applicationByTeam));
}

async function notifySkillMatchesForTeam(team: any, hackathon: any, owner: any) {
  const targetSkills = cleanList([
    ...(team.requiredSkills || []),
    ...(hackathon.skills || []),
  ], 16, 48);
  if (targetSkills.length === 0) return;

  const candidates = await prisma.user.findMany({
    where: {
      id: { not: team.ownerId },
      isBanned: false,
      OR: [
        {
          skills: {
            some: {
              skill: {
                OR: targetSkills.map((skill) => ({
                  name: { equals: skill, mode: 'insensitive' },
                })),
              },
            },
          },
        },
        { interests: { hasSome: targetSkills } },
        { user_onboarding: { canTeach: { hasSome: targetSkills } } },
      ],
    },
    select: { id: true, college: true },
    take: 30,
  });

  const sorted = candidates.sort((a, b) => {
    const aSameCollege = Number(Boolean(a.college && hackathon.college && a.college === hackathon.college));
    const bSameCollege = Number(Boolean(b.college && hackathon.college && b.college === hackathon.college));
    return bSameCollege - aSameCollege;
  });

  await Promise.allSettled(sorted.slice(0, 20).map((candidate) =>
    notificationService.notifyHackathonTeamMatch(candidate.id, team.ownerId, {
      ownerName: owner?.name || 'Someone',
      hackathonTitle: hackathon.title,
      teamId: team.id,
      hackathonId: hackathon.id,
      skills: targetSkills.slice(0, 4),
    })
  ));
}

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

    const where: any = { isActive: true };
    if (status === 'active') {
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

export const importExternalHackathonSources = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const sources = cleanList(req.body?.sources, 4, 24)
      .map((source) => source.toLowerCase())
      .filter((source) => source === 'devfolio' || source === 'mlh');
    const result = await importExternalHackathons({
      sources: sources.length ? sources as Array<'devfolio' | 'mlh'> : undefined,
    });

    res.json(result);
  } catch (error) {
    console.error('importExternalHackathonSources error:', error);
    res.status(500).json({ error: 'Failed to import external hackathons' });
  }
};

export const createHackathon = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const title = cleanText(req.body.title, 120);
    const description = cleanText(req.body.description, 2000);
    const startsAt = parseRequiredDate(req.body.startsAt, 'startsAt');
    const endsAt = parseRequiredDate(req.body.endsAt, 'endsAt');
    if (!title || !description) {
      res.status(400).json({ error: 'Title and description are required' });
      return;
    }
    if (endsAt <= startsAt) {
      res.status(400).json({ error: 'endsAt must be after startsAt' });
      return;
    }

    const source = cleanText(req.body.source, 40).toLowerCase();
    const normalizedSource = HACKATHON_SOURCES.has(source) ? source : 'college_fest';
    const teamMin = Math.min(12, Math.max(1, Number(req.body.teamMin) || 1));
    const teamMax = Math.min(12, Math.max(teamMin, Number(req.body.teamMax) || 4));
    const slug = await uniqueHackathonSlug(title, startsAt);

    const hackathon = await prisma.hackathons.create({
      data: {
        slug,
        title,
        organizer: cleanOptionalText(req.body.organizer, 120),
        source: normalizedSource,
        sourceUrl: cleanOptionalText(req.body.sourceUrl, 500),
        sourceId: cleanOptionalText(req.body.sourceId, 120),
        college: cleanOptionalText(req.body.college, 160),
        description,
        theme: cleanOptionalText(req.body.theme, 120),
        location: cleanOptionalText(req.body.location, 160),
        isOnline: Boolean(req.body.isOnline),
        startsAt,
        endsAt,
        registrationDeadline: parseOptionalDate(req.body.registrationDeadline),
        teamMin,
        teamMax,
        prizeSummary: cleanOptionalText(req.body.prizeSummary, 240),
        tags: cleanList(req.body.tags, 16, 48),
        skills: cleanList(req.body.skills, 16, 48),
        bannerUrl: cleanOptionalText(req.body.bannerUrl, 500),
        createdById: userId,
      },
      include: { _count: { select: { teams: true, saves: true } } },
    });

    res.status(201).json({ hackathon: formatHackathon(hackathon) });
  } catch (error) {
    console.error('createHackathon error:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create hackathon' });
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
