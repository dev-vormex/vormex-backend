import { prisma } from '../config/prisma';
import { notificationService } from './notification.service';
import { pushNotificationService } from './push-notification.service';

const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_LOOKBACK_DAYS = 45;
const DEFAULT_MAX_RECIPIENTS = 150;
const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

type MatchNotificationSource =
  | 'signup'
  | 'google_signup'
  | 'profile_update'
  | 'onboarding_update'
  | 'onboarding_complete'
  | 'skill_add'
  | 'interest_add'
  | 'interest_update';

type MatchReasonKey = 'same_college' | 'same_goal' | 'shared_interests' | 'shared_skills';

type MatchSignalUser = {
  college: string | null;
  createdAt: Date;
  id: string;
  interests: string[];
  isBanned: boolean;
  lastActiveAt: Date | null;
  name: string;
  skills: Array<{
    skill: {
      name: string;
    };
  }>;
  user_onboarding: {
    primaryGoal: string | null;
  } | null;
};

type RecipientSignalUser = MatchSignalUser;

export type MatchRecommendationScore = {
  primaryReason: MatchReasonKey;
  reasonKeys: MatchReasonKey[];
  sameCollege: boolean;
  sameGoal: boolean;
  score: number;
  sharedInterests: string[];
  sharedSkills: string[];
};

type MatchRecommendationCandidate = MatchRecommendationScore & {
  userId: string;
};

export type MatchAvailabilityCopy = {
  body: string;
  title: string;
};

export type MatchAvailabilityNotificationResult = {
  notified: number;
  skipped: number;
  subjectUserId: string;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function isMatchAvailabilityEnabled(): boolean {
  const raw = process.env.MATCH_AVAILABILITY_NOTIFICATIONS_ENABLED;
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueNormalized(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = normalizeText(value)?.toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function collectSkillNames(user: Pick<MatchSignalUser, 'skills'>): string[] {
  return uniqueNormalized(user.skills.map((entry) => entry.skill?.name));
}

function collectInterestNames(user: Pick<MatchSignalUser, 'interests'>): string[] {
  return uniqueNormalized(user.interests || []);
}

function intersectValues(primary: string[], secondary: string[]): string[] {
  const secondarySet = new Set(uniqueNormalized(secondary));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of primary) {
    const normalized = normalizeText(value);
    const key = normalized?.toLowerCase();
    if (!normalized || !key || !secondarySet.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function formatListPreview(items: string[]): string {
  if (items.length <= 0) {
    return 'something valuable';
  }

  if (items.length === 1) {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items[0]}, ${items[1]}, and ${items.length - 2} more`;
}

function isFreshJoin(subjectUser: Pick<MatchSignalUser, 'createdAt'>, source: MatchNotificationSource, now: Date): boolean {
  if (source === 'signup' || source === 'google_signup') {
    return true;
  }

  return now.getTime() - subjectUser.createdAt.getTime() <= RECENT_ACTIVITY_WINDOW_MS;
}

export function scoreMatchRecommendation(
  subjectUser: MatchSignalUser,
  recipientUser: RecipientSignalUser,
  now: Date = new Date()
): MatchRecommendationScore {
  const subjectCollege = normalizeText(subjectUser.college)?.toLowerCase();
  const recipientCollege = normalizeText(recipientUser.college)?.toLowerCase();
  const subjectGoal = normalizeText(subjectUser.user_onboarding?.primaryGoal)?.toLowerCase();
  const recipientGoal = normalizeText(recipientUser.user_onboarding?.primaryGoal)?.toLowerCase();
  const sharedInterests = intersectValues(subjectUser.interests || [], recipientUser.interests || []);
  const sharedSkills = intersectValues(
    subjectUser.skills.map((entry) => entry.skill?.name || ''),
    recipientUser.skills.map((entry) => entry.skill?.name || '')
  );

  const sameCollege = Boolean(subjectCollege && recipientCollege && subjectCollege === recipientCollege);
  const sameGoal = Boolean(subjectGoal && recipientGoal && subjectGoal === recipientGoal);

  let score = 0;
  const reasonKeys: MatchReasonKey[] = [];

  if (sameCollege) {
    score += 25;
    reasonKeys.push('same_college');
  }

  if (sharedSkills.length > 0) {
    score += Math.min(3, sharedSkills.length) * 18;
    reasonKeys.push('shared_skills');
  }

  if (sharedInterests.length > 0) {
    score += Math.min(3, sharedInterests.length) * 12;
    reasonKeys.push('shared_interests');
  }

  if (sameGoal) {
    score += 20;
    reasonKeys.push('same_goal');
  }

  if (
    recipientUser.lastActiveAt &&
    now.getTime() - recipientUser.lastActiveAt.getTime() <= RECENT_ACTIVITY_WINDOW_MS
  ) {
    score += 5;
  }

  const primaryReason = reasonKeys[0] || 'shared_interests';

  return {
    primaryReason,
    reasonKeys,
    sameCollege,
    sameGoal,
    score,
    sharedInterests,
    sharedSkills,
  };
}

export function buildMatchAvailabilityCopy(
  subjectUser: MatchSignalUser,
  recommendation: MatchRecommendationScore,
  source: MatchNotificationSource,
  now: Date = new Date()
): MatchAvailabilityCopy {
  const freshJoin = isFreshJoin(subjectUser, source, now);
  const subjectName = normalizeText(subjectUser.name) || 'A new builder';
  const college = normalizeText(subjectUser.college);
  const goal = normalizeText(subjectUser.user_onboarding?.primaryGoal);

  if (recommendation.sameCollege && college) {
    return {
      title: freshJoin ? `Someone from ${college} just joined` : `A strong match from ${college} is ready`,
      body: freshJoin
        ? `${subjectName} just joined Vormex from ${college}. Open Find People and connect early.`
        : `${subjectName} now matches you through ${college}. Open Find People and start the conversation.`,
    };
  }

  if (recommendation.sharedSkills.length > 0) {
    const skillsPreview = formatListPreview(recommendation.sharedSkills.slice(0, 3));
    return {
      title: `${skillsPreview} match on Vormex`,
      body: freshJoin
        ? `${subjectName} just joined and shares ${skillsPreview} with you. This is a strong match worth opening.`
        : `${subjectName} now lines up with you on ${skillsPreview}. Open Find People before this goes cold.`,
    };
  }

  if (recommendation.sharedInterests.length > 0) {
    const interestsPreview = formatListPreview(recommendation.sharedInterests.slice(0, 3));
    return {
      title: `${interestsPreview} people are here`,
      body: freshJoin
        ? `${subjectName} just joined and shares interests like ${interestsPreview}. Go say hi while the timing is perfect.`
        : `${subjectName} is now a better match for you through ${interestsPreview}. Open Find People and connect.`,
    };
  }

  if (recommendation.sameGoal && goal) {
    return {
      title: `${goal} match available`,
      body: freshJoin
        ? `${subjectName} just joined and is chasing ${goal} too. Open Find People and build together.`
        : `${subjectName} now shares your goal: ${goal}. Open Find People and turn it into a real connection.`,
    };
  }

  return {
    title: 'New recommended match on Vormex',
    body: freshJoin
      ? `${subjectName} just joined and looks like a useful match for you. Open Find People and connect early.`
      : `${subjectName} is now showing up as a stronger match for you. Open Find People and check it out.`,
  };
}

async function loadSubjectUser(userId: string): Promise<MatchSignalUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      college: true,
      createdAt: true,
      id: true,
      interests: true,
      isBanned: true,
      lastActiveAt: true,
      name: true,
      skills: {
        select: {
          skill: {
            select: {
              name: true,
            },
          },
        },
      },
      user_onboarding: {
        select: {
          primaryGoal: true,
        },
      },
    },
  });
}

async function loadConnectedIds(userId: string): Promise<string[]> {
  const connections = await prisma.connections.findMany({
    where: {
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: {
      addresseeId: true,
      requesterId: true,
    },
  });

  const excluded = new Set<string>([userId]);
  for (const connection of connections) {
    excluded.add(connection.requesterId);
    excluded.add(connection.addresseeId);
  }

  return Array.from(excluded);
}

function buildCandidateWhere(subjectUser: MatchSignalUser, excludedIds: string[], lookbackBoundary: Date) {
  const matchClauses: Array<Record<string, unknown>> = [];
  const subjectCollege = normalizeText(subjectUser.college);
  const subjectGoal = normalizeText(subjectUser.user_onboarding?.primaryGoal);
  const subjectInterests = collectInterestNames(subjectUser);
  const subjectSkills = collectSkillNames(subjectUser);

  if (subjectCollege) {
    matchClauses.push({ college: subjectCollege });
  }

  if (subjectInterests.length > 0) {
    matchClauses.push({ interests: { hasSome: subjectUser.interests } });
  }

  if (subjectGoal) {
    matchClauses.push({
      user_onboarding: {
        is: {
          primaryGoal: subjectGoal,
        },
      },
    });
  }

  if (subjectSkills.length > 0) {
    matchClauses.push({
      OR: subjectSkills.map((skill) => ({
        skills: {
          some: {
            skill: {
              name: {
                equals: skill,
                mode: 'insensitive',
              },
            },
          },
        },
      })),
    });
  }

  if (matchClauses.length === 0) {
    return null;
  }

  return {
    AND: [
      {
        OR: matchClauses,
      },
      {
        OR: [
          { lastActiveAt: { gte: lookbackBoundary } },
          { createdAt: { gte: lookbackBoundary } },
        ],
      },
    ],
    id: { notIn: excludedIds },
    isBanned: false,
  };
}

async function loadRecentlyNotifiedRecipients(
  recipientIds: string[],
  actorId: string,
  cooldownBoundary: Date
): Promise<Set<string>> {
  if (recipientIds.length === 0) {
    return new Set<string>();
  }

  const recent = await prisma.notifications.findMany({
    where: {
      actorId,
      createdAt: { gte: cooldownBoundary },
      type: 'recommended_match',
      userId: { in: recipientIds },
    },
    select: {
      userId: true,
    },
    distinct: ['userId'],
  });

  return new Set(recent.map((entry) => entry.userId));
}

async function notifyRecipientAboutMatch(
  recipientUserId: string,
  subjectUser: MatchSignalUser,
  recommendation: MatchRecommendationCandidate,
  source: MatchNotificationSource,
  now: Date
): Promise<void> {
  const copy = buildMatchAvailabilityCopy(subjectUser, recommendation, source, now);
  const notificationData = {
    matchReasons: recommendation.reasonKeys,
    matchScore: recommendation.score,
    matchUserId: subjectUser.id,
    screen: 'find_people',
    source,
    tab: 'smart_matches',
  };

  await Promise.all([
    notificationService.notifyRecommendedMatch(
      recipientUserId,
      subjectUser.id,
      copy.title,
      copy.body,
      notificationData
    ),
    pushNotificationService.pushRecommendedMatch(recipientUserId, copy.title, copy.body, {
      actorId: subjectUser.id,
      matchReason: recommendation.primaryReason,
      matchScore: String(recommendation.score),
      matchUserId: subjectUser.id,
      screen: 'find_people',
      source,
      tab: 'smart_matches',
    }),
  ]);
}

export async function notifyUsersAboutMatchAvailability(
  subjectUserId: string,
  source: MatchNotificationSource,
  now: Date = new Date()
): Promise<MatchAvailabilityNotificationResult> {
  if (!isMatchAvailabilityEnabled()) {
    return {
      notified: 0,
      skipped: 0,
      subjectUserId,
    };
  }

  const subjectUser = await loadSubjectUser(subjectUserId);
  if (!subjectUser || subjectUser.isBanned) {
    return {
      notified: 0,
      skipped: 0,
      subjectUserId,
    };
  }

  const subjectCollege = normalizeText(subjectUser.college);
  const subjectGoal = normalizeText(subjectUser.user_onboarding?.primaryGoal);
  const subjectInterests = collectInterestNames(subjectUser);
  const subjectSkills = collectSkillNames(subjectUser);

  if (!subjectCollege && !subjectGoal && subjectInterests.length === 0 && subjectSkills.length === 0) {
    return {
      notified: 0,
      skipped: 0,
      subjectUserId,
    };
  }

  const maxRecipients = parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_MAX_RECIPIENTS,
    DEFAULT_MAX_RECIPIENTS
  );
  const lookbackDays = parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_LOOKBACK_DAYS,
    DEFAULT_LOOKBACK_DAYS
  );
  const cooldownHours = parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_COOLDOWN_HOURS,
    DEFAULT_COOLDOWN_HOURS
  );
  const lookbackBoundary = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const cooldownBoundary = new Date(now.getTime() - cooldownHours * 60 * 60 * 1000);
  const excludedIds = await loadConnectedIds(subjectUserId);
  const candidateWhere = buildCandidateWhere(subjectUser, excludedIds, lookbackBoundary);

  if (!candidateWhere) {
    return {
      notified: 0,
      skipped: 0,
      subjectUserId,
    };
  }

  const recipients = await prisma.user.findMany({
    where: candidateWhere as any,
    orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      college: true,
      createdAt: true,
      id: true,
      interests: true,
      isBanned: true,
      lastActiveAt: true,
      name: true,
      skills: {
        select: {
          skill: {
            select: {
              name: true,
            },
          },
        },
      },
      user_onboarding: {
        select: {
          primaryGoal: true,
        },
      },
    },
    take: Math.max(maxRecipients * 4, maxRecipients),
  });

  const scoredCandidates = recipients
    .map((recipient) => ({
      userId: recipient.id,
      ...scoreMatchRecommendation(subjectUser, recipient as RecipientSignalUser, now),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxRecipients);

  const recentlyNotified = await loadRecentlyNotifiedRecipients(
    scoredCandidates.map((candidate) => candidate.userId),
    subjectUser.id,
    cooldownBoundary
  );

  let notified = 0;
  let skipped = 0;

  const batchSize = 10;
  for (let index = 0; index < scoredCandidates.length; index += batchSize) {
    const batch = scoredCandidates.slice(index, index + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (candidate) => {
        if (recentlyNotified.has(candidate.userId)) {
          skipped += 1;
          return;
        }

        await notifyRecipientAboutMatch(candidate.userId, subjectUser, candidate, source, now);
        notified += 1;
      })
    );

    results.forEach((result) => {
      if (result.status === 'rejected') {
        skipped += 1;
      }
    });
  }

  return {
    notified,
    skipped,
    subjectUserId,
  };
}

export function queueMatchAvailabilityNotifications(
  subjectUserId: string,
  source: MatchNotificationSource,
  now: Date = new Date()
): void {
  void notifyUsersAboutMatchAvailability(subjectUserId, source, now).catch((error) => {
    console.error(
      `Failed to process match availability notifications for user ${subjectUserId} via ${source}:`,
      error
    );
  });
}
