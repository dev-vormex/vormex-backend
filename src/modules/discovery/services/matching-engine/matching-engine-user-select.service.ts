import type { PremiumVisibilityState } from "../../../premium/services/premium-visibility.service";

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

export const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STRONG_MATCH_THRESHOLD = 70;

export const DEFAULT_MATCH_NOTIFICATION_COOLDOWN_HOURS = 72;

export const DEFAULT_MATCH_LOOKBACK_DAYS = 45;

export const DEFAULT_MAX_RECIPIENTS = 150;

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeKey(value: string | null | undefined): string | null {
  return normalizeText(value)?.toLowerCase() || null;
}

export function uniqueLabels(values: Array<string | null | undefined>): string[] {
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

export function intersectLabels(left: string[], right: string[]): string[] {
  const rightKeys = new Set(right.map(normalizeKey).filter(Boolean) as string[]);
  return uniqueLabels(left).filter((label) => {
    const key = normalizeKey(label);
    return Boolean(key && rightKeys.has(key));
  });
}

export function formatListPreview(items: string[], fallback = 'matching signals'): string {
  const labels = uniqueLabels(items);
  if (labels.length === 0) return fallback;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

export function canUsePublicCoordinates(user: MatchingSignalUser): boolean {
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

export function profileStrength(user: MatchingSignalUser): number {
  let completed = 0;
  if (normalizeText(user.headline)) completed += 1;
  if (normalizeText(user.bio)) completed += 1;
  if (normalizeText(user.college)) completed += 1;
  if (collectSkillNames(user).length > 0) completed += 1;
  if (collectInterests(user).length > 0) completed += 1;
  if (user.githubConnected) completed += 1;
  return Math.min(3, Math.ceil(completed / 2));
}

export function premiumBoostScore(visibility?: PremiumVisibilityState): number {
  if (!visibility) return 0;
  if (visibility.profileBoostActive) return 3;
  if (visibility.creatorProActive) return 2;
  if (visibility.isPremium) return 1;
  return 0;
}

export function stableTieBreak(userId: string): number {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash % 100) / 1000;
}

export function recentActivityScore(user: MatchingSignalUser, now: Date): number {
  let score = 0;
  if (user.isOnline) score += 3;
  if (user.lastActiveAt && now.getTime() - new Date(user.lastActiveAt).getTime() <= RECENT_ACTIVITY_WINDOW_MS) {
    score += 4;
  }
  return score;
}

export function buildSummary(candidate: MatchingSignalUser, sharedSignals: MatchingSharedSignals, reasonKeys: MatchReasonKey[]): string {
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

export function scorecardSignals(items: string[], fallback: string): string[] {
  return items.length > 0 ? items.slice(0, 3) : [fallback];
}
