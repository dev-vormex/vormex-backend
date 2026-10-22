import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { isUUID } from "../../../../shared/utils/username.util";

export const MAX_SKILL_LENGTH = 80;

export const DEFAULT_SESSION_LENGTH = 30;

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

export function normalizeSkillName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SKILL_LENGTH);
}

export function skillKey(value: string): string {
  return normalizeSkillName(value).toLowerCase();
}

export function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const normalized = normalizeSkillName(value);
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  });
  return result;
}

export function overlaps(left: string[], right: string[]): boolean {
  const rightKeys = right.map(skillKey).filter(Boolean);
  return left.some((item) => {
    const leftKey = skillKey(item);
    return rightKeys.some((rightKey) => leftKey.includes(rightKey) || rightKey.includes(leftKey));
  });
}

export function evidenceMatchesSkill(evidenceSkill: string, skill: string): boolean {
  const left = skillKey(evidenceSkill);
  const right = skillKey(skill);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

export function formatUserCard(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    profileImage: user.profileImage,
    headline: user.headline,
    college: user.college,
    branch: user.branch,
    graduationYear: user.graduationYear,
    isOnline: Boolean(user.isOnline),
    lastActiveAt: user.lastActiveAt?.toISOString?.() ?? user.lastActiveAt ?? null,
  };
}

export function skillSwapDisplayName(user: any, fallback = 'Someone') {
  return ensureString(user?.name) || ensureString(user?.username) || fallback;
}

export async function resolveUser(identifier: string, requestingUserId: string | null) {
  let userId = ensureString(identifier);
  if (!userId) return null;
  if (userId.startsWith('@')) userId = userId.slice(1);
  if (userId.toLowerCase() === 'me') {
    if (!requestingUserId) return null;
    userId = requestingUserId;
  }

  return prisma.user.findFirst({
    where: isUUID(userId) ? { id: userId } : { username: userId.toLowerCase() },
    select: {
      ...userCardSelect,
      bio: true,
      interests: true,
      githubConnected: true,
      githubUsername: true,
      githubProfileUrl: true,
      user_onboarding: {
        select: {
          wantToLearn: true,
          canTeach: true,
          primaryGoal: true,
          lookingFor: true,
        },
      },
      skills: {
        select: {
          id: true,
          proficiency: true,
          yearsOfExp: true,
          createdAt: true,
          skill: { select: { id: true, name: true, category: true } },
        },
      },
      projects: {
        orderBy: [{ featured: 'desc' }, { updatedAt: 'desc' }],
        select: {
          id: true,
          name: true,
          description: true,
          role: true,
          techStack: true,
          projectUrl: true,
          githubUrl: true,
          featured: true,
          updatedAt: true,
          createdAt: true,
        },
      },
      certificates: {
        orderBy: { issueDate: 'desc' },
        select: {
          id: true,
          name: true,
          issuingOrg: true,
          credentialUrl: true,
          issueDate: true,
          createdAt: true,
        },
      },
      experiences: {
        orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }],
        select: {
          id: true,
          title: true,
          company: true,
          skills: true,
          isCurrent: true,
          startDate: true,
          createdAt: true,
        },
      },
      achievements: {
        orderBy: { date: 'desc' },
        select: {
          id: true,
          title: true,
          type: true,
          organization: true,
          description: true,
          certificateUrl: true,
          date: true,
          createdAt: true,
        },
      },
      githubStats: {
        select: {
          topLanguages: true,
          topRepos: true,
          totalPublicRepos: true,
          totalStars: true,
          lastCalculatedAt: true,
        },
      },
    },
  });
}

export async function findOrCreateSkill(name: string) {
  const normalized = normalizeSkillName(name);
  if (!normalized) {
    throw new Error('Skill is required');
  }

  const existing = await prisma.skill.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
  });
  if (existing) return existing;

  return prisma.skill.create({
    data: { name: normalized },
  });
}

export function safeJsonArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function topLanguageName(item: any): string {
  return normalizeSkillName(item?.name || item?.language || item?.label || item?.key || '');
}

export function topRepoSkills(item: any): string[] {
  const values = [
    item?.language,
    ...(Array.isArray(item?.languages) ? item.languages : []),
    ...(Array.isArray(item?.topics) ? item.topics : []),
  ];
  return uniqueStrings(values);
}

export async function areConnected(leftUserId: string, rightUserId: string): Promise<boolean> {
  const connection = await prisma.connections.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: leftUserId, addresseeId: rightUserId },
        { requesterId: rightUserId, addresseeId: leftUserId },
      ],
    },
    select: { id: true },
  });
  return Boolean(connection);
}

export function normalizeProvider(value: unknown): string {
  const provider = (ensureString(value) || '').toLowerCase();
  if (['github', 'leetcode', 'portfolio'].includes(provider)) return provider;
  return '';
}

export function providerProfileUrl(provider: string, username: string, profileUrl?: string | null): string | null {
  if (profileUrl) return profileUrl;
  if (provider === 'github') return `https://github.com/${encodeURIComponent(username)}`;
  if (provider === 'leetcode') return `https://leetcode.com/${encodeURIComponent(username)}/`;
  return null;
}

export async function getCurrentSkillProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      college: true,
      branch: true,
      interests: true,
      user_onboarding: {
        select: { wantToLearn: true, canTeach: true, primaryGoal: true, lookingFor: true },
      },
      skills: { select: { skill: { select: { name: true } } } },
    },
  });
}

export async function hydrateSkillSwapRows(rows: any[], sessions: any[] = []) {
  const userIds = Array.from(new Set(rows.flatMap((row) => [row.requesterId, row.recipientId])));
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: userCardSelect,
  });
  const userById = new Map(users.map((user) => [user.id, user]));
  const sessionByRequestId = new Map(sessions.map((session) => [session.requestId, session]));

  return rows.map((row) => ({
    id: row.id,
    skill: row.skill,
    message: row.message,
    requesterGoal: row.requesterGoal,
    mode: row.mode,
    status: row.status,
    sessionLengthMinutes: row.sessionLengthMinutes,
    scheduledFor: row.scheduledFor?.toISOString?.() ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? null,
    respondedAt: row.respondedAt?.toISOString?.() ?? null,
    requester: formatUserCard(userById.get(row.requesterId)),
    recipient: formatUserCard(userById.get(row.recipientId)),
    session: sessionByRequestId.has(row.id) ? formatSession(sessionByRequestId.get(row.id), userById) : null,
  }));
}

export function formatSession(session: any, userById?: Map<string, any>) {
  return {
    id: session.id,
    requestId: session.requestId,
    skill: session.skill,
    status: session.status,
    sessionLengthMinutes: session.sessionLengthMinutes,
    scheduledFor: session.scheduledFor?.toISOString?.() ?? null,
    completedAt: session.completedAt?.toISOString?.() ?? null,
    learnerRating: session.learnerRating,
    mentorRating: session.mentorRating,
    learnerNote: session.learnerNote,
    mentorNote: session.mentorNote,
    createdAt: session.createdAt?.toISOString?.() ?? null,
    mentor: userById ? formatUserCard(userById.get(session.mentorId)) : null,
    learner: userById ? formatUserCard(userById.get(session.learnerId)) : null,
  };
}
