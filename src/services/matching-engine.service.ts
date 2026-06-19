import { prisma } from '../config/prisma';
import type { PremiumVisibilityState } from './premium-visibility.service';

export type MatchFilterType = 'all' | 'same_campus' | 'same_goal' | 'mentor' | 'mentee';

export type MatchNotificationSource =
  | 'signup'
  | 'google_signup'
  | 'profile_update'
  | 'onboarding_update'
  | 'onboarding_complete'
  | 'skill_add'
  | 'interest_add'
  | 'interest_update'
  | 'location_update'
  | 'daily_digest';

export type MatchReasonKey =
  | 'shared_skills'
  | 'complementary_skills'
  | 'shared_interests'
  | 'same_goal'
  | 'same_college'
  | 'same_city'
  | 'nearby'
  | 'recently_active'
  | 'profile_strength';

export type MatchingScorecardItem = {
  label: 'Skills' | 'Interests' | 'Goals' | 'Location' | 'Activity';
  score: number;
  max: number;
  signals: string[];
};

export type MatchingWhyMatched = {
  summary: string;
  bullets: string[];
  scorecard: MatchingScorecardItem[];
};

export type MatchingSharedSignals = {
  skills: string[];
  interests: string[];
  goals: string[];
  locationLabel: string | null;
  distanceKm?: number;
};

export type MatchingScore = {
  activityScore: number;
  candidate: MatchingSignalUser;
  goalScore: number;
  interestScore: number;
  locationScore: number;
  matchPercentage: number;
  primaryReason: MatchReasonKey;
  reasonKeys: MatchReasonKey[];
  reasons: string[];
  score: number;
  sharedSignals: MatchingSharedSignals;
  skillScore: number;
  tags: string[];
  whyMatched: MatchingWhyMatched;
};

export type MatchingSignalUser = {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  headline: string | null;
  isVerified: boolean;
  profileBadgeStyle: string | null;
  college: string | null;
  branch: string | null;
  graduationYear: number | null;
  interests: string[];
  isBanned: boolean;
  bio: string | null;
  githubConnected: boolean;
  isOnline: boolean;
  lastActiveAt: Date | null;
  createdAt: Date;
  currentCity: string | null;
  currentState: string | null;
  currentCountry: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  locationPermission: boolean | null;
  shareLocationPublic: boolean | null;
  onboardingCompleted: boolean;
  user_onboarding: {
    primaryGoal: string | null;
    secondaryGoals: string[];
    wantToLearn: string[];
    canTeach: string[];
    lookingFor: string[];
    availability: string | null;
  } | null;
  user_goals: Array<{
    goal: string;
    category: string | null;
    priority: number;
  }>;
  skills: Array<{
    proficiency: string | null;
    yearsOfExp: number | null;
    skill: {
      name: string;
    };
  }>;
  userStats: {
    connectionsCount: number;
    xp: number;
    level: number;
  } | null;
};

export const MATCHING_ENGINE_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
  college: true,
  branch: true,
  graduationYear: true,
  interests: true,
  isBanned: true,
  bio: true,
  githubConnected: true,
  isOnline: true,
  lastActiveAt: true,
  createdAt: true,
  currentCity: true,
  currentState: true,
  currentCountry: true,
  location: true,
  latitude: true,
  longitude: true,
  locationPermission: true,
  shareLocationPublic: true,
  onboardingCompleted: true,
  user_onboarding: {
    select: {
      primaryGoal: true,
      secondaryGoals: true,
      wantToLearn: true,
      canTeach: true,
      lookingFor: true,
      availability: true,
    },
  },
  user_goals: {
    select: {
      goal: true,
      category: true,
      priority: true,
    },
    orderBy: [{ priority: 'desc' as const }, { createdAt: 'desc' as const }],
    take: 8,
  },
  skills: {
    select: {
      proficiency: true,
      yearsOfExp: true,
      skill: { select: { name: true } },
    },
  },
  userStats: {
    select: {
      connectionsCount: true,
      xp: true,
      level: true,
    },
  },
};

const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const STRONG_MATCH_THRESHOLD = 70;
const DEFAULT_MATCH_NOTIFICATION_COOLDOWN_HOURS = 72;
const DEFAULT_MATCH_LOOKBACK_DAYS = 45;
const DEFAULT_MAX_RECIPIENTS = 150;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeKey(value: string | null | undefined): string | null {
  return normalizeText(value)?.toLowerCase() || null;
}

function uniqueLabels(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const value of values) {
    const label = normalizeText(value);
    const key = normalizeKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  return labels;
}

function intersectLabels(left: string[], right: string[]): string[] {
  const rightKeys = new Set(right.map(normalizeKey).filter(Boolean) as string[]);
  return uniqueLabels(left).filter((label) => {
    const key = normalizeKey(label);
    return Boolean(key && rightKeys.has(key));
  });
}

function formatListPreview(items: string[], fallback = 'matching signals'): string {
  const labels = uniqueLabels(items);
  if (labels.length === 0) return fallback;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusKm * c;
}

function canUsePublicCoordinates(user: MatchingSignalUser): boolean {
  return (
    user.shareLocationPublic === true &&
    user.locationPermission !== false &&
    typeof user.latitude === 'number' &&
    typeof user.longitude === 'number'
  );
}

export function collectSkillNames(user: Pick<MatchingSignalUser, 'skills' | 'user_onboarding'>): string[] {
  return uniqueLabels([
    ...(user.skills || []).map((entry) => entry.skill?.name),
    ...(user.user_onboarding?.canTeach || []),
  ]);
}

export function collectSkillsToLearn(user: Pick<MatchingSignalUser, 'user_onboarding'>): string[] {
  return uniqueLabels(user.user_onboarding?.wantToLearn || []);
}

export function collectInterests(user: Pick<MatchingSignalUser, 'interests'>): string[] {
  return uniqueLabels(user.interests || []);
}

export function collectGoals(user: Pick<MatchingSignalUser, 'user_onboarding' | 'user_goals'>): string[] {
  return uniqueLabels([
    user.user_onboarding?.primaryGoal,
    ...(user.user_onboarding?.secondaryGoals || []),
    ...(user.user_goals || []).map((goal) => goal.goal),
  ]);
}

function profileStrength(user: MatchingSignalUser): number {
  let completed = 0;
  if (normalizeText(user.headline)) completed += 1;
  if (normalizeText(user.bio)) completed += 1;
  if (normalizeText(user.college)) completed += 1;
  if (collectSkillNames(user).length > 0) completed += 1;
  if (collectInterests(user).length > 0) completed += 1;
  if (user.githubConnected) completed += 1;
  return Math.min(3, Math.ceil(completed / 2));
}

function premiumBoostScore(visibility?: PremiumVisibilityState): number {
  if (!visibility) return 0;
  if (visibility.profileBoostActive) return 3;
  if (visibility.creatorProActive) return 2;
  if (visibility.isPremium) return 1;
  return 0;
}

function stableTieBreak(userId: string): number {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash % 100) / 1000;
}

function recentActivityScore(user: MatchingSignalUser, now: Date): number {
  let score = 0;
  if (user.isOnline) score += 3;
  if (user.lastActiveAt && now.getTime() - new Date(user.lastActiveAt).getTime() <= RECENT_ACTIVITY_WINDOW_MS) {
    score += 4;
  }
  return score;
}

function buildSummary(candidate: MatchingSignalUser, sharedSignals: MatchingSharedSignals, reasonKeys: MatchReasonKey[]): string {
  const name = normalizeText(candidate.name) || normalizeText(candidate.username) || 'This person';
  if (reasonKeys.includes('complementary_skills') && sharedSignals.skills.length > 0) {
    return `${name} lines up with what you want to learn: ${formatListPreview(sharedSignals.skills.slice(0, 3))}.`;
  }
  if (reasonKeys.includes('shared_skills') && sharedSignals.skills.length > 0) {
    return `${name} shares ${formatListPreview(sharedSignals.skills.slice(0, 3), 'skills')} with you.`;
  }
  if (reasonKeys.includes('same_goal') && sharedSignals.goals.length > 0) {
    return `${name} is chasing ${formatListPreview(sharedSignals.goals.slice(0, 2), 'a similar goal')} too.`;
  }
  if (sharedSignals.interests.length > 0) {
    return `${name} shares interests like ${formatListPreview(sharedSignals.interests.slice(0, 3))}.`;
  }
  if (sharedSignals.locationLabel) {
    return `${name} is close to your network through ${sharedSignals.locationLabel}.`;
  }
  return `${name} has enough profile signal to be worth a closer look.`;
}

function scorecardSignals(items: string[], fallback: string): string[] {
  return items.length > 0 ? items.slice(0, 3) : [fallback];
}

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

function skillNameClauses(skills: string[]) {
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

export function buildMatchingCandidateWhere(
  currentUser: MatchingSignalUser,
  options: {
    type?: MatchFilterType;
    excludedIds?: string[];
    lookbackBoundary?: Date;
  } = {}
) {
  const type = options.type || 'all';
  const excludedIds = Array.from(new Set([currentUser.id, ...(options.excludedIds || [])]));
  const skills = collectSkillNames(currentUser);
  const wantToLearn = collectSkillsToLearn(currentUser);
  const interests = collectInterests(currentUser);
  const goals = collectGoals(currentUser);
  const city = normalizeText(currentUser.currentCity || currentUser.location);
  const college = normalizeText(currentUser.college);
  const branch = normalizeText(currentUser.branch);

  const baseWhere: any = {
    id: { notIn: excludedIds },
    isBanned: false,
  };

  const andClauses: any[] = [];
  const orClauses: any[] = [];

  if (options.lookbackBoundary) {
    andClauses.push({
      OR: [
        { lastActiveAt: { gte: options.lookbackBoundary } },
        { createdAt: { gte: options.lookbackBoundary } },
      ],
    });
  }

  if (type === 'same_campus') {
    if (college) baseWhere.college = college;
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (type === 'same_goal') {
    if (goals.length > 0) {
      baseWhere.OR = [
        { user_onboarding: { is: { primaryGoal: { in: goals } } } },
        { user_goals: { some: { goal: { in: goals } } } },
      ];
    }
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (type === 'mentor') {
    const learnSignals = uniqueLabels(wantToLearn);
    if (learnSignals.length > 0) {
      baseWhere.OR = [
        { user_onboarding: { is: { canTeach: { hasSome: learnSignals } } } },
        ...skillNameClauses(learnSignals),
      ];
    }
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (type === 'mentee') {
    const teachSignals = uniqueLabels(skills);
    if (teachSignals.length > 0) {
      baseWhere.OR = [
        { user_onboarding: { is: { wantToLearn: { hasSome: teachSignals } } } },
      ];
    }
    return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
  }

  if (college) orClauses.push({ college });
  if (branch) orClauses.push({ branch });
  if (city) {
    orClauses.push({ currentCity: { contains: city, mode: 'insensitive' } });
    orClauses.push({ location: { contains: city, mode: 'insensitive' } });
  }
  if (interests.length > 0) orClauses.push({ interests: { hasSome: interests } });
  if (goals.length > 0) {
    orClauses.push({ user_onboarding: { is: { primaryGoal: { in: goals } } } });
    orClauses.push({ user_goals: { some: { goal: { in: goals } } } });
  }
  orClauses.push(...skillNameClauses(skills));
  if (wantToLearn.length > 0) {
    orClauses.push({ user_onboarding: { is: { canTeach: { hasSome: wantToLearn } } } });
    orClauses.push(...skillNameClauses(wantToLearn));
  }

  if (orClauses.length > 0) {
    andClauses.push({ OR: orClauses });
  }

  return andClauses.length > 0 ? { ...baseWhere, AND: andClauses } : baseWhere;
}

export function getMatchNotificationCooldownHours(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_COOLDOWN_HOURS,
    DEFAULT_MATCH_NOTIFICATION_COOLDOWN_HOURS
  );
}

export function getMatchNotificationLookbackDays(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_LOOKBACK_DAYS,
    DEFAULT_MATCH_LOOKBACK_DAYS
  );
}

export function getMatchNotificationMaxRecipients(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_MAX_RECIPIENTS,
    DEFAULT_MAX_RECIPIENTS
  );
}

export function getStrongMatchThreshold(): number {
  return parsePositiveInt(
    process.env.MATCH_AVAILABILITY_NOTIFICATIONS_MIN_SCORE,
    STRONG_MATCH_THRESHOLD
  );
}

export function isStrongMatch(match: Pick<MatchingScore, 'matchPercentage'>): boolean {
  return match.matchPercentage >= getStrongMatchThreshold();
}

export function buildRecommendedMatchCopy(
  subjectUser: MatchingSignalUser,
  match: MatchingScore,
  source: MatchNotificationSource,
  now: Date = new Date()
) {
  const subjectName = normalizeText(subjectUser.name) || 'A new builder';
  const freshJoin =
    source === 'signup' ||
    source === 'google_signup' ||
    now.getTime() - new Date(subjectUser.createdAt).getTime() <= RECENT_ACTIVITY_WINDOW_MS;
  const strongestSignal = match.sharedSignals.skills[0] ||
    match.sharedSignals.goals[0] ||
    match.sharedSignals.interests[0] ||
    match.sharedSignals.locationLabel;

  if (match.primaryReason === 'same_college' && match.sharedSignals.locationLabel) {
    return {
      title: freshJoin ? `Someone from ${match.sharedSignals.locationLabel} just joined` : `Strong campus match ready`,
      body: `${subjectName} matches you through ${match.sharedSignals.locationLabel}. ${match.whyMatched.summary}`,
    };
  }

  if (match.primaryReason === 'complementary_skills' && strongestSignal) {
    return {
      title: `${strongestSignal} match on Vormex`,
      body: `${subjectName} is a ${match.matchPercentage}% match. ${match.whyMatched.summary}`,
    };
  }

  if (match.primaryReason === 'shared_skills' && strongestSignal) {
    return {
      title: `${strongestSignal} builder matched`,
      body: `${subjectName} shares skills with you. ${match.whyMatched.summary}`,
    };
  }

  if (match.primaryReason === 'same_goal' && strongestSignal) {
    return {
      title: `${strongestSignal} match available`,
      body: `${subjectName} has the same goal. ${match.whyMatched.summary}`,
    };
  }

  return {
    title: 'New high-quality match',
    body: `${subjectName} is a ${match.matchPercentage}% match. ${match.whyMatched.summary}`,
  };
}

export function serializeMatchedUser(
  user: MatchingSignalUser,
  visibility?: PremiumVisibilityState
) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    profileImage: user.profileImage,
    headline: user.headline,
    verified: Boolean(user.isVerified),
    isVerified: Boolean(user.isVerified),
    profileBadgeStyle: user.profileBadgeStyle ?? null,
    isPremium: Boolean(visibility?.isPremium),
    profileBoostActive: Boolean(visibility?.profileBoostActive),
    profileBoostEndsAt: visibility?.profileBoostEndsAt?.toISOString() || null,
    profileBoostPriority: visibility?.profileBoostPriority || 0,
    discoveryPriority: visibility?.discoveryPriority || 0,
    college: user.college,
    branch: user.branch,
    graduationYear: user.graduationYear,
    interests: user.interests || [],
    bio: user.bio,
    githubConnected: user.githubConnected,
    skills: (user.skills || []).map((entry) => entry.skill.name),
    onboarding: user.user_onboarding
      ? {
          primaryGoal: user.user_onboarding.primaryGoal || null,
          lookingFor: Array.isArray(user.user_onboarding.lookingFor)
            ? user.user_onboarding.lookingFor
            : [],
        }
      : null,
    stats: user.userStats
      ? {
          connectionsCount: user.userStats.connectionsCount,
          xp: user.userStats.xp,
          level: user.userStats.level,
        }
      : null,
  };
}
