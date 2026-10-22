import { EXTERNAL_HACKATHON_SOURCES } from "../../services/hackathon-import.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { slugify } from "../../../groups/services/group-slug.service";
import { prisma } from "../../../../config/prisma";
import { notificationService } from "../../../notifications/services/notification.service";

export const EXTERNAL_HACKATHON_SOURCE_SET = new Set(EXTERNAL_HACKATHON_SOURCES);

export const HACKATHON_SOURCES = new Set([...EXTERNAL_HACKATHON_SOURCES, 'college_fest', 'custom']);

export const TEAM_STATUS_OPEN = 'open';

export const TEAM_STATUS_FULL = 'full';

export const userCardSelect = {
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

export function cleanText(value: unknown, max = 240): string {
  return (ensureString(value) || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanOptionalText(value: unknown, max = 240): string | null {
  const text = cleanText(value, max);
  return text || null;
}

export function cleanList(value: unknown, maxItems = 12, maxLen = 48): string[] {
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

export async function uniqueHackathonSlug(title: string, startsAt: Date): Promise<string> {
  const base = slugify(`${title}-${startsAt.getUTCFullYear()}`);
  let slug = base;
  let suffix = 2;
  while (await prisma.hackathons.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

export function parseRequiredDate(value: unknown, label: string): Date {
  const date = new Date(ensureString(value) || '');
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

export function parseOptionalDate(value: unknown): Date | null {
  const raw = ensureString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function computedHackathonStatus(hackathon: any, now = new Date()): string {
  if (!hackathon.isActive) return 'archived';
  if (hackathon.endsAt < now) return 'past';
  if (hackathon.startsAt > now) return 'upcoming';
  return 'active';
}

export function formatUser(user: any) {
  if (!user) return null;
  return {
    ...user,
    isOnline: Boolean(user.isOnline),
    lastActiveAt: user.lastActiveAt?.toISOString?.() ?? user.lastActiveAt ?? null,
  };
}

export function formatHackathon(row: any, context: { savedIds?: Set<string>; userTeamByHackathon?: Map<string, any> } = {}) {
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

export function formatTeam(row: any, usersById?: Map<string, any>, applicationByTeam?: Map<string, any>) {
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

export function formatApplication(row: any, usersById?: Map<string, any>) {
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

export async function hydrateTeams(teams: any[], currentUserId?: string | null) {
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

export async function notifySkillMatchesForTeam(team: any, hackathon: any, owner: any) {
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
