import { prisma } from '../config/prisma';
import { notificationService } from './notification.service';
import { pushNotificationService } from './push-notification.service';
import { getPremiumVisibilityByUserIds } from './premium-visibility.service';
import {
  MATCHING_ENGINE_USER_SELECT,
  buildMatchingCandidateWhere,
  buildRecommendedMatchCopy,
  collectGoals,
  collectInterests,
  collectSkillNames,
  collectSkillsToLearn,
  getConnectedOrPendingUserIds,
  getMatchNotificationCooldownHours,
  getMatchNotificationLookbackDays,
  getMatchNotificationMaxRecipients,
  isStrongMatch,
  rankUserMatches,
  scoreUserMatch,
  type MatchNotificationSource,
  type MatchReasonKey,
  type MatchingScore,
  type MatchingSignalUser,
} from './matching-engine.service';

export type { MatchNotificationSource };

export type MatchRecommendationScore = {
  primaryReason: MatchReasonKey;
  reasonKeys: MatchReasonKey[];
  sameCollege: boolean;
  sameGoal: boolean;
  score: number;
  matchPercentage: number;
  sharedInterests: string[];
  sharedSkills: string[];
  whySummary: string;
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

export type HighQualityMatchDigestResult = {
  notified: number;
  processed: number;
  skipped: number;
};

function isMatchAvailabilityEnabled(): boolean {
  const raw = process.env.MATCH_AVAILABILITY_NOTIFICATIONS_ENABLED;
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function hasMatchingSignals(user: MatchingSignalUser): boolean {
  return (
    Boolean(user.college || user.currentCity || user.location) ||
    collectSkillNames(user).length > 0 ||
    collectSkillsToLearn(user).length > 0 ||
    collectInterests(user).length > 0 ||
    collectGoals(user).length > 0
  );
}

function toMatchRecommendationScore(match: MatchingScore): MatchRecommendationScore {
  return {
    primaryReason: match.primaryReason,
    reasonKeys: match.reasonKeys,
    sameCollege: match.reasonKeys.includes('same_college'),
    sameGoal: match.reasonKeys.includes('same_goal'),
    score: match.score,
    matchPercentage: match.matchPercentage,
    sharedInterests: match.sharedSignals.interests,
    sharedSkills: match.sharedSignals.skills,
    whySummary: match.whyMatched.summary,
  };
}

export function scoreMatchRecommendation(
  subjectUser: MatchingSignalUser,
  recipientUser: MatchingSignalUser,
  now: Date = new Date()
): MatchRecommendationScore {
  const match = scoreUserMatch(recipientUser, subjectUser, { now });
  return toMatchRecommendationScore(match);
}

function formatListPreview(items: string[]): string {
  if (items.length <= 0) return 'matching signals';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items[0]}, ${items[1]}, and ${items.length - 2} more`;
}

export function buildMatchAvailabilityCopy(
  subjectUser: MatchingSignalUser,
  recommendation: MatchRecommendationScore,
  source: MatchNotificationSource,
  now: Date = new Date()
): MatchAvailabilityCopy {
  const pseudoMatch = {
    candidate: subjectUser,
    matchPercentage: recommendation.matchPercentage ?? Math.round(recommendation.score),
    primaryReason: recommendation.primaryReason,
    sharedSignals: {
      skills: recommendation.sharedSkills,
      interests: recommendation.sharedInterests,
      goals: recommendation.sameGoal ? collectGoals(subjectUser).slice(0, 2) : [],
      locationLabel: recommendation.sameCollege ? subjectUser.college : null,
    },
    whyMatched: {
      summary: recommendation.whySummary || (
        recommendation.sharedSkills.length > 0
          ? `${subjectUser.name} shares ${formatListPreview(recommendation.sharedSkills)} with you.`
          : `${subjectUser.name} is a strong match for you.`
      ),
      bullets: [],
      scorecard: [],
    },
  } as MatchingScore;

  return buildRecommendedMatchCopy(subjectUser, pseudoMatch, source, now);
}

async function loadMatchingUser(userId: string): Promise<MatchingSignalUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: MATCHING_ENGINE_USER_SELECT,
  }) as Promise<MatchingSignalUser | null>;
}

async function loadRecentlyNotifiedRecipients(
  recipientIds: string[],
  actorId: string,
  cooldownBoundary: Date
): Promise<Set<string>> {
  if (recipientIds.length === 0) return new Set<string>();

  const recent = await prisma.notifications.findMany({
    where: {
      actorId,
      createdAt: { gte: cooldownBoundary },
      type: 'recommended_match',
      userId: { in: recipientIds },
    },
    select: { userId: true },
    distinct: ['userId'],
  });

  return new Set(recent.map((entry) => entry.userId));
}

async function hasRecentRecommendedMatchForUser(userId: string, boundary: Date): Promise<boolean> {
  const recent = await prisma.notifications.findFirst({
    where: {
      userId,
      type: 'recommended_match',
      createdAt: { gte: boundary },
    },
    select: { id: true },
  });
  return Boolean(recent);
}

async function notifyRecipientAboutMatch(
  recipientUserId: string,
  subjectUser: MatchingSignalUser,
  match: MatchingScore,
  source: MatchNotificationSource,
  now: Date
): Promise<void> {
  const copy = buildRecommendedMatchCopy(subjectUser, match, source, now);
  const notificationData = {
    matchReasons: match.reasonKeys,
    matchScore: match.matchPercentage,
    matchPercentage: match.matchPercentage,
    matchUserId: subjectUser.id,
    screen: 'find_people',
    source,
    tab: 'smart_matches',
    whySummary: match.whyMatched.summary,
    sharedSignals: match.sharedSignals,
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
      matchReason: match.primaryReason,
      matchScore: String(match.matchPercentage),
      matchUserId: subjectUser.id,
      screen: 'find_people',
      source,
      tab: 'smart_matches',
      whySummary: match.whyMatched.summary,
    }),
  ]);
}

export async function notifyUsersAboutMatchAvailability(
  subjectUserId: string,
  source: MatchNotificationSource,
  now: Date = new Date()
): Promise<MatchAvailabilityNotificationResult> {
  if (!isMatchAvailabilityEnabled()) {
    return { notified: 0, skipped: 0, subjectUserId };
  }

  const subjectUser = await loadMatchingUser(subjectUserId);
  if (!subjectUser || subjectUser.isBanned || !hasMatchingSignals(subjectUser)) {
    return { notified: 0, skipped: 0, subjectUserId };
  }

  const maxRecipients = getMatchNotificationMaxRecipients();
  const lookbackDays = getMatchNotificationLookbackDays();
  const cooldownHours = getMatchNotificationCooldownHours();
  const lookbackBoundary = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const cooldownBoundary = new Date(now.getTime() - cooldownHours * 60 * 60 * 1000);
  const excludedIds = await getConnectedOrPendingUserIds(subjectUserId);
  const candidateWhere = buildMatchingCandidateWhere(subjectUser, {
    excludedIds,
    lookbackBoundary,
  });

  const recipients = await prisma.user.findMany({
    where: candidateWhere as any,
    orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
    select: MATCHING_ENGINE_USER_SELECT,
    take: Math.max(maxRecipients * 4, maxRecipients),
  }) as MatchingSignalUser[];

  if (recipients.length === 0) {
    return { notified: 0, skipped: 0, subjectUserId };
  }

  const visibilityByUser = await getPremiumVisibilityByUserIds([subjectUser.id]);
  const subjectVisibility = visibilityByUser.get(subjectUser.id);
  const scoredCandidates = recipients
    .map((recipient) => ({
      recipient,
      match: scoreUserMatch(recipient, subjectUser, {
        candidateVisibility: subjectVisibility,
        now,
      }),
    }))
    .filter(({ match }) => isStrongMatch(match))
    .sort((left, right) =>
      right.match.matchPercentage - left.match.matchPercentage ||
      right.match.score - left.match.score
    )
    .slice(0, maxRecipients);

  const recentlyNotified = await loadRecentlyNotifiedRecipients(
    scoredCandidates.map((candidate) => candidate.recipient.id),
    subjectUser.id,
    cooldownBoundary
  );

  let notified = 0;
  let skipped = 0;
  const batchSize = 10;

  for (let index = 0; index < scoredCandidates.length; index += batchSize) {
    const batch = scoredCandidates.slice(index, index + batchSize);
    const results = await Promise.allSettled(
      batch.map(async ({ recipient, match }) => {
        const recipientUserId = recipient.id;
        if (recentlyNotified.has(recipientUserId)) {
          skipped += 1;
          return;
        }

        await notifyRecipientAboutMatch(recipientUserId, subjectUser, match, source, now);
        notified += 1;
      })
    );

    results.forEach((result) => {
      if (result.status === 'rejected') skipped += 1;
    });
  }

  return { notified, skipped, subjectUserId };
}

export async function runHighQualityMatchDigest(now: Date = new Date()): Promise<HighQualityMatchDigestResult> {
  if (!isMatchAvailabilityEnabled()) {
    return { processed: 0, notified: 0, skipped: 0 };
  }

  const usersWithTokens = await prisma.device_tokens.findMany({
    where: { isActive: true },
    select: { userId: true },
    distinct: ['userId'],
  });

  let processed = 0;
  let notified = 0;
  let skipped = 0;
  const oneDayBoundary = new Date(now.getTime() - 20 * 60 * 60 * 1000);

  for (const tokenOwner of usersWithTokens) {
    processed += 1;
    try {
      const currentUser = await loadMatchingUser(tokenOwner.userId);
      if (!currentUser || currentUser.isBanned || !hasMatchingSignals(currentUser)) {
        skipped += 1;
        continue;
      }
      if (await hasRecentRecommendedMatchForUser(currentUser.id, oneDayBoundary)) {
        skipped += 1;
        continue;
      }

      const excludedIds = await getConnectedOrPendingUserIds(currentUser.id);
      const where = buildMatchingCandidateWhere(currentUser, { excludedIds });
      const candidates = await prisma.user.findMany({
        where: where as any,
        orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
        select: MATCHING_ENGINE_USER_SELECT,
        take: 80,
      }) as MatchingSignalUser[];

      if (candidates.length === 0) {
        skipped += 1;
        continue;
      }

      const visibilityByUser = await getPremiumVisibilityByUserIds(candidates.map((candidate) => candidate.id));
      const topMatch = rankUserMatches(currentUser, candidates, { visibilityByUser, now })
        .find(isStrongMatch);

      if (!topMatch) {
        skipped += 1;
        continue;
      }

      const cooldownBoundary = new Date(now.getTime() - getMatchNotificationCooldownHours() * 60 * 60 * 1000);
      const alreadyNotified = await loadRecentlyNotifiedRecipients(
        [currentUser.id],
        topMatch.candidate.id,
        cooldownBoundary
      );
      if (alreadyNotified.has(currentUser.id)) {
        skipped += 1;
        continue;
      }

      await notifyRecipientAboutMatch(currentUser.id, topMatch.candidate, topMatch, 'daily_digest', now);
      notified += 1;
    } catch (error) {
      skipped += 1;
      console.error(`Failed to send high-quality match digest to ${tokenOwner.userId}:`, error);
    }
  }

  return { processed, notified, skipped };
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
