import { prisma } from "../../../../config/prisma";
import type { PremiumVisibilityState } from "../../../premium/services/premium-visibility.service";
import { MatchingSignalUser, MatchingScore, collectSkillNames, collectSkillsToLearn, collectInterests, collectGoals, intersectLabels, uniqueLabels, normalizeKey, canUsePublicCoordinates, haversineKm, recentActivityScore, profileStrength, premiumBoostScore, MatchReasonKey, formatListPreview, pluralize, MatchingSharedSignals, MatchingWhyMatched, buildSummary, scorecardSignals, stableTieBreak } from "./matching-engine-user-select.service";

export function scoreUserMatch(
  currentUser: MatchingSignalUser,
  candidate: MatchingSignalUser,
  options: {
    candidateVisibility?: PremiumVisibilityState;
    mutualConnections?: number;
    now?: Date;
  } = {}
): MatchingScore {
  const now = options.now || new Date();
  const currentSkills = collectSkillNames(currentUser);
  const candidateSkills = collectSkillNames(candidate);
  const currentWantsToLearn = collectSkillsToLearn(currentUser);
  const candidateWantsToLearn = collectSkillsToLearn(candidate);
  const currentInterests = collectInterests(currentUser);
  const candidateInterests = collectInterests(candidate);
  const currentGoals = collectGoals(currentUser);
  const candidateGoals = collectGoals(candidate);

  const sharedSkills = intersectLabels(candidateSkills, currentSkills);
  const candidateCanTeachCurrent = intersectLabels(candidateSkills, currentWantsToLearn);
  const currentCanTeachCandidate = intersectLabels(currentSkills, candidateWantsToLearn);
  const sharedInterests = intersectLabels(candidateInterests, currentInterests);
  const sharedGoals = intersectLabels(candidateGoals, currentGoals);

  const skillSignals = uniqueLabels([
    ...candidateCanTeachCurrent,
    ...sharedSkills,
    ...currentCanTeachCandidate,
  ]);
  const skillScore = Math.min(
    30,
    candidateCanTeachCurrent.length * 9 +
      sharedSkills.length * 6 +
      currentCanTeachCandidate.length * 5
  );
  const interestScore = Math.min(20, sharedInterests.length * 7);
  const goalScore = Math.min(20, sharedGoals.length * 12);

  const sameCollege = Boolean(
    normalizeKey(currentUser.college) &&
      normalizeKey(currentUser.college) === normalizeKey(candidate.college)
  );
  const sameBranch = Boolean(
    normalizeKey(currentUser.branch) &&
      normalizeKey(currentUser.branch) === normalizeKey(candidate.branch)
  );
  const sameCity = Boolean(
    normalizeKey(currentUser.currentCity || currentUser.location) &&
      normalizeKey(currentUser.currentCity || currentUser.location) ===
        normalizeKey(candidate.currentCity || candidate.location)
  );
  const distanceKm =
    canUsePublicCoordinates(currentUser) && canUsePublicCoordinates(candidate)
      ? Math.round(
          haversineKm(
            currentUser.latitude!,
            currentUser.longitude!,
            candidate.latitude!,
            candidate.longitude!
          ) * 10
        ) / 10
      : undefined;
  const nearbyScore =
    distanceKm === undefined
      ? 0
      : distanceKm <= 10
        ? 5
        : distanceKm <= 50
          ? 3
          : distanceKm <= 150
            ? 1
            : 0;
  const locationScore = Math.min(
    15,
    (sameCollege ? 8 : 0) +
      (sameBranch ? 2 : 0) +
      (sameCity ? 5 : 0) +
      nearbyScore
  );
  const locationLabel =
    sameCollege && candidate.college
      ? candidate.college
      : sameCity
        ? candidate.currentCity || candidate.location
        : distanceKm !== undefined && nearbyScore > 0
          ? `${distanceKm} km away`
          : null;

  const mutualConnections = Math.max(0, options.mutualConnections || 0);
  const activityScore = Math.min(
    15,
    recentActivityScore(candidate, now) +
      profileStrength(candidate) +
      Math.min(2, mutualConnections) +
      Math.min(3, Math.floor((candidate.userStats?.level || 1) / 4)) +
      premiumBoostScore(options.candidateVisibility)
  );

  const score = Math.min(100, skillScore + interestScore + goalScore + locationScore + activityScore);
  const matchPercentage = Math.max(0, Math.min(100, Math.round(score)));

  const reasonKeys: MatchReasonKey[] = [];
  if (candidateCanTeachCurrent.length > 0 || currentCanTeachCandidate.length > 0) {
    reasonKeys.push('complementary_skills');
  }
  if (sharedSkills.length > 0) reasonKeys.push('shared_skills');
  if (sharedInterests.length > 0) reasonKeys.push('shared_interests');
  if (sharedGoals.length > 0) reasonKeys.push('same_goal');
  if (sameCollege) reasonKeys.push('same_college');
  if (!sameCollege && sameCity) reasonKeys.push('same_city');
  if (nearbyScore > 0) reasonKeys.push('nearby');
  if (recentActivityScore(candidate, now) > 0) reasonKeys.push('recently_active');
  if (profileStrength(candidate) >= 2) reasonKeys.push('profile_strength');

  const reasons = uniqueLabels([
    candidateCanTeachCurrent.length > 0
      ? `Can help with ${formatListPreview(candidateCanTeachCurrent.slice(0, 2))}`
      : null,
    currentCanTeachCandidate.length > 0
      ? `You can help with ${formatListPreview(currentCanTeachCandidate.slice(0, 2))}`
      : null,
    sharedSkills.length > 0 ? `${pluralize(sharedSkills.length, 'shared skill')}` : null,
    sharedInterests.length > 0 ? `${pluralize(sharedInterests.length, 'shared interest')}` : null,
    sharedGoals.length > 0 ? 'Shared goal' : null,
    sameCollege ? 'Same college' : null,
    !sameCollege && sameCity ? 'Same city' : null,
    nearbyScore > 0 && distanceKm !== undefined ? `${distanceKm} km away` : null,
    recentActivityScore(candidate, now) > 0 ? 'Recently active' : null,
  ]);
  const tags = uniqueLabels([
    ...reasons.slice(0, 4),
    ...skillSignals.slice(0, 2),
    ...sharedInterests.slice(0, 2),
    ...sharedGoals.slice(0, 1),
  ]).slice(0, 8);
  const sharedSignals: MatchingSharedSignals = {
    skills: skillSignals,
    interests: sharedInterests,
    goals: sharedGoals,
    locationLabel,
    ...(distanceKm !== undefined && nearbyScore > 0 ? { distanceKm } : {}),
  };

  const bullets = uniqueLabels([
    candidateCanTeachCurrent.length > 0
      ? `They can teach ${formatListPreview(candidateCanTeachCurrent.slice(0, 3))}, which you want to learn.`
      : null,
    currentCanTeachCandidate.length > 0
      ? `You can help them with ${formatListPreview(currentCanTeachCandidate.slice(0, 3))}.`
      : null,
    sharedSkills.length > 0
      ? `You both list ${formatListPreview(sharedSkills.slice(0, 3))}.`
      : null,
    sharedInterests.length > 0
      ? `Shared interests: ${formatListPreview(sharedInterests.slice(0, 3))}.`
      : null,
    sharedGoals.length > 0
      ? `Shared goals: ${formatListPreview(sharedGoals.slice(0, 2))}.`
      : null,
    locationLabel ? `Location signal: ${locationLabel}.` : null,
    recentActivityScore(candidate, now) > 0 ? 'They have been active recently.' : null,
  ]).slice(0, 6);

  const whyMatched: MatchingWhyMatched = {
    summary: buildSummary(candidate, sharedSignals, reasonKeys),
    bullets,
    scorecard: [
      {
        label: 'Skills',
        score: skillScore,
        max: 30,
        signals: scorecardSignals(skillSignals, 'No strong skill overlap yet'),
      },
      {
        label: 'Interests',
        score: interestScore,
        max: 20,
        signals: scorecardSignals(sharedInterests, 'No shared interests yet'),
      },
      {
        label: 'Goals',
        score: goalScore,
        max: 20,
        signals: scorecardSignals(sharedGoals, 'No shared goal yet'),
      },
      {
        label: 'Location',
        score: locationScore,
        max: 15,
        signals: locationLabel ? [locationLabel] : ['No location signal used'],
      },
      {
        label: 'Activity',
        score: activityScore,
        max: 15,
        signals: uniqueLabels([
          candidate.isOnline ? 'Online now' : null,
          candidate.lastActiveAt ? 'Recently active' : null,
          profileStrength(candidate) >= 2 ? 'Complete profile' : null,
          mutualConnections > 0 ? `${pluralize(mutualConnections, 'mutual connection')}` : null,
          options.candidateVisibility?.profileBoostActive ? 'Boosted discovery' : null,
        ]).slice(0, 3),
      },
    ],
  };

  return {
    activityScore,
    candidate,
    goalScore,
    interestScore,
    locationScore,
    matchPercentage,
    primaryReason: reasonKeys[0] || 'profile_strength',
    reasonKeys,
    reasons,
    score: Math.round((score + stableTieBreak(candidate.id)) * 10) / 10,
    sharedSignals,
    skillScore,
    tags,
    whyMatched,
  };
}

export function rankUserMatches(
  currentUser: MatchingSignalUser,
  candidates: MatchingSignalUser[],
  options: {
    visibilityByUser?: Map<string, PremiumVisibilityState>;
    mutualConnectionsByUser?: Map<string, number>;
    now?: Date;
  } = {}
): MatchingScore[] {
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (!candidate || candidate.id === currentUser.id || candidate.isBanned) return false;
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    })
    .map((candidate) =>
      scoreUserMatch(currentUser, candidate, {
        candidateVisibility: options.visibilityByUser?.get(candidate.id),
        mutualConnections: options.mutualConnectionsByUser?.get(candidate.id) || 0,
        now: options.now,
      })
    )
    .sort((left, right) => {
      if (right.matchPercentage !== left.matchPercentage) {
        return right.matchPercentage - left.matchPercentage;
      }
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const rightActive = right.candidate.lastActiveAt ? new Date(right.candidate.lastActiveAt).getTime() : 0;
      const leftActive = left.candidate.lastActiveAt ? new Date(left.candidate.lastActiveAt).getTime() : 0;
      if (rightActive !== leftActive) return rightActive - leftActive;
      return left.candidate.name.localeCompare(right.candidate.name);
    });
}

export async function getConnectedOrPendingUserIds(userId: string): Promise<string[]> {
  const connections = await prisma.connections.findMany({
    where: {
      OR: [{ requesterId: userId }, { addresseeId: userId }],
      status: { in: ['accepted', 'pending'] },
    },
    select: { requesterId: true, addresseeId: true },
  });

  const excluded = new Set<string>([userId]);
  for (const connection of connections) {
    excluded.add(connection.requesterId);
    excluded.add(connection.addresseeId);
  }
  return Array.from(excluded);
}

export function skillNameClauses(skills: string[]) {
  return uniqueLabels(skills).slice(0, 10).map((skill) => ({
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
  }));
}
