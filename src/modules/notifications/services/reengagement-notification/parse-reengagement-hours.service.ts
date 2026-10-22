import { asTrimmedString as normalizeText } from "../../../../shared/utils/text-value.util";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DEFAULT_SLOT_HOURS_IST = [15, 16, 17, 18, 19, 20, 21, 22, 23, 0];

export const DEFAULT_MATCH_POOL_SIZE = 12;

export const DEFAULT_LOOKBACK_DAYS = 30;

const DEFAULT_MAX_PER_DAY = 10;

export const RECENTLY_ACTIVE_MS = 24 * 60 * 60 * 1000;

const SLOT_TONES = [
  'intro_match',
  'same_campus_or_goal',
  'start_building',
  'streak_warning',
  'days_on_vormex',
  'growth_zero',
  'real_growth',
  'late_hour',
  'no_sleep',
  'final_call',
] as const;

type SlotTone = (typeof SLOT_TONES)[number];

type CampaignType = 'match' | 'growth' | 'streak';

export type MatchReason = 'same_goal' | 'same_college' | 'same_goal_same_college' | 'active_builder' | 'recommended';

export type ConfiguredSlot = {
  hourIst: number;
  index: number;
  isRolloverFinalSlot: boolean;
  key: string;
  tone: SlotTone;
};

export type UserSnapshot = {
  id: string;
  college: string | null;
  createdAt: Date;
  isBanned: boolean;
  isOnline: boolean;
  lastActiveAt: Date | null;
  name: string;
  user_onboarding: {
    primaryGoal: string | null;
  } | null;
  userStats: {
    connectionsCount: number;
    currentStreak: number;
    totalActiveDays: number;
    xp: number;
  } | null;
  engagement_streaks: {
    connectionStreak: number;
    loginStreak: number;
    messagingStreak: number;
    postingStreak: number;
  } | null;
  _count: {
    posts: number;
  };
};

export type MatchCandidate = {
  id: string;
  isRecentlyActive: boolean;
  name: string;
  primaryGoal: string | null;
  reason: MatchReason;
  sameCollege: boolean;
  sameGoal: boolean;
};

export type ReengagementCopyInput = {
  candidate: MatchCandidate | null;
  currentUser: Pick<UserSnapshot, 'college' | 'createdAt' | 'user_onboarding'> & {
    connectionsCount: number;
    meaningfulGrowthCount: number;
    postsCount: number;
    totalActiveDays: number;
  };
  highestStreak: number;
  slot: ConfiguredSlot;
};

export type ReengagementGrowthSnapshot = {
  acceptedConnections: number;
  directMessages: number;
  groupMessages: number;
  postComments: number;
  postsCreated: number;
  reelComments: number;
  reelsCreated: number;
};

export type ReengagementCopy = {
  body: string;
  campaignType: CampaignType;
  data: Record<string, string>;
  title: string;
};

export type ReengagementRunResult = {
  currentIstHour: number;
  failed: number;
  processed: number;
  sent: number;
  skipped: number;
  slotKey: string | null;
};

export type ReengagementAdminPreviewResult = {
  candidate: {
    id: string;
    isRecentlyActive: boolean;
    name: string;
    primaryGoal: string | null;
    reason: MatchReason;
    sameCollege: boolean;
    sameGoal: boolean;
  } | null;
  copy: ReengagementCopy | null;
  currentIstHour: number;
  eligible: boolean;
  enabled: boolean;
  existingDeliveryStatus: string | null;
  growthSnapshot: ReengagementGrowthSnapshot;
  hasActiveDeviceToken: boolean;
  hasMeaningfulGrowthToday: boolean;
  highestStreak: number;
  meaningfulGrowthCount: number;
  reason:
    | 'already_grew_today'
    | 'already_sent_for_slot'
    | 'eligible'
    | 'no_active_device_token'
    | 'outside_lookback_window'
    | 'outside_slot_window'
    | 'reengagement_disabled'
    | 'user_banned'
    | 'user_not_found'
    | 'user_online';
  sendAttempted: boolean;
  sent: boolean;
  slotDateKey: string | null;
  slotKey: string | null;
  user: {
    college: string | null;
    createdAt: Date | null;
    id: string;
    isBanned: boolean;
    isOnline: boolean;
    lastActiveAt: Date | null;
    name: string | null;
    primaryGoal: string | null;
  } | null;
};

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

export function parseReengagementHours(raw: string | undefined = process.env.REENGAGEMENT_SLOT_HOURS_IST): number[] {
  const values = (raw || DEFAULT_SLOT_HOURS_IST.join(','))
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23);

  if (values.length === 0) {
    return [...DEFAULT_SLOT_HOURS_IST];
  }

  const seen = new Set<number>();
  const unique: number[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }

  return unique;
}

export function getConfiguredReengagementSlots(): ConfiguredSlot[] {
  const parsedHours = parseReengagementHours();
  const maxPerDay = parsePositiveInt(process.env.REENGAGEMENT_MAX_PER_DAY, DEFAULT_MAX_PER_DAY);
  const cappedHours = parsedHours.slice(0, maxPerDay);

  return cappedHours.map((hourIst, index) => ({
    hourIst,
    index,
    isRolloverFinalSlot: hourIst === 0 && index === cappedHours.length - 1,
    key: `ist_${String(hourIst).padStart(2, '0')}`,
    tone: SLOT_TONES[Math.min(index, SLOT_TONES.length - 1)],
  }));
}

export function isReengagementEnabled(): boolean {
  const raw = process.env.REENGAGEMENT_ENABLED;
  if (!raw) return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function shiftToIst(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

export function formatDateKey(date: Date): string {
  const shifted = shiftToIst(date);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getIstStartOfDayUtc(date: Date): Date {
  const shifted = shiftToIst(date);
  const startUtcMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    0,
    0,
    0,
    0
  ) - IST_OFFSET_MS;
  return new Date(startUtcMs);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export { asTrimmedString as normalizeText } from "../../../../shared/utils/text-value.util";

export function pluralizeDays(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function getPrimaryGoalLabel(primaryGoal: string | null | undefined): string | null {
  return normalizeText(primaryGoal);
}

export function getDaysOnVormex(createdAt: Date): number {
  const diffMs = Math.max(0, Date.now() - createdAt.getTime());
  return Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1);
}

export function getHighestTrackedStreak(user: UserSnapshot): number {
  const tracked = user.engagement_streaks;
  if (!tracked) {
    return user.userStats?.currentStreak || 0;
  }

  return Math.max(
    tracked.connectionStreak || 0,
    tracked.loginStreak || 0,
    tracked.messagingStreak || 0,
    tracked.postingStreak || 0,
    user.userStats?.currentStreak || 0
  );
}

function describeGenericMatchTarget(user: ReengagementCopyInput['currentUser']): string {
  const primaryGoal = getPrimaryGoalLabel(user.user_onboarding?.primaryGoal);
  if (primaryGoal) {
    return `someone chasing ${primaryGoal}`;
  }

  if (normalizeText(user.college)) {
    return `someone from ${user.college}`;
  }

  return 'someone who wants real growth';
}

export function describeCandidateReason(candidate: MatchCandidate | null, user: ReengagementCopyInput['currentUser']): string {
  if (!candidate) {
    return describeGenericMatchTarget(user);
  }

  if (candidate.reason === 'same_goal_same_college') {
    return `${candidate.name}, who shares your goal and college`;
  }

  if (candidate.reason === 'same_goal') {
    return `${candidate.name}, who matches your goal`;
  }

  if (candidate.reason === 'same_college') {
    return `${candidate.name} from ${user.college || 'your college'}`;
  }

  if (candidate.isRecentlyActive) {
    return `${candidate.name}, who is active on Vormex right now`;
  }

  return candidate.name;
}
