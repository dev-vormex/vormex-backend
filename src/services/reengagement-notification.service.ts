import { prisma } from '../config/prisma';
import { pushNotificationService } from './push-notification.service';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_SLOT_HOURS_IST = [15, 16, 17, 18, 19, 20, 21, 22, 23, 0];
const DEFAULT_MATCH_POOL_SIZE = 12;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_PER_DAY = 10;
const RECENTLY_ACTIVE_MS = 24 * 60 * 60 * 1000;
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
type MatchReason = 'same_goal' | 'same_college' | 'same_goal_same_college' | 'active_builder' | 'recommended';

type ConfiguredSlot = {
  hourIst: number;
  index: number;
  isRolloverFinalSlot: boolean;
  key: string;
  tone: SlotTone;
};

type UserSnapshot = {
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

type MatchCandidate = {
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

function parsePositiveInt(raw: string | undefined, fallback: number): number {
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

function shiftToIst(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function formatDateKey(date: Date): string {
  const shifted = shiftToIst(date);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getIstStartOfDayUtc(date: Date): Date {
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pluralizeDays(days: number): string {
  return `${days} day${days === 1 ? '' : 's'}`;
}

function getPrimaryGoalLabel(primaryGoal: string | null | undefined): string | null {
  return normalizeText(primaryGoal);
}

function getDaysOnVormex(createdAt: Date): number {
  const diffMs = Math.max(0, Date.now() - createdAt.getTime());
  return Math.max(1, Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1);
}

function getHighestTrackedStreak(user: UserSnapshot): number {
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

function describeCandidateReason(candidate: MatchCandidate | null, user: ReengagementCopyInput['currentUser']): string {
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

export function buildReengagementCopy(input: ReengagementCopyInput): ReengagementCopy {
  const { candidate, currentUser, highestStreak, slot } = input;
  const primaryGoal = getPrimaryGoalLabel(currentUser.user_onboarding?.primaryGoal);
  const college = normalizeText(currentUser.college);
  const daysOnVormex = getDaysOnVormex(currentUser.createdAt);
  const growthZero = currentUser.meaningfulGrowthCount === 0;
  const candidateReason = describeCandidateReason(candidate, currentUser);

  switch (slot.tone) {
    case 'intro_match':
      return {
        title: college ? `Someone from ${college} is ready` : 'A strong match is waiting',
        body: `${candidateReason} is a smart first move for today. Open Vormex and start one meaningful conversation.`,
        campaignType: 'match',
        data: {
          hook: 'intro_match',
        },
      };
    case 'same_campus_or_goal':
      return {
        title: primaryGoal ? `${primaryGoal} people are here` : 'Your people are already on Vormex',
        body: `${candidateReason} fits where you want to grow. Open the app and build with intent, not just scroll.`,
        campaignType: 'match',
        data: {
          hook: 'same_campus_or_goal',
        },
      };
    case 'start_building':
      return {
        title: 'You can start building today',
        body: `This is bigger than adding one more connection. Open Vormex and turn ${candidateReason} into something meaningful.`,
        campaignType: 'growth',
        data: {
          hook: 'start_building',
        },
      };
    case 'streak_warning':
      if (highestStreak >= 2) {
        return {
          title: `Protect your ${highestStreak}-day streak`,
          body: `You still have time today. Open Vormex now and keep your momentum alive before the day closes.`,
          campaignType: 'streak',
          data: {
            hook: 'streak_warning',
            streakCount: String(highestStreak),
          },
        };
      }

      return {
        title: 'Momentum breaks quietly',
        body: `Open Vormex before tonight gets away from you. ${candidateReason} could be the move that starts your next streak.`,
        campaignType: 'growth',
        data: {
          hook: 'streak_warning_fallback',
        },
      };
    case 'days_on_vormex':
      return {
        title: `${pluralizeDays(daysOnVormex)} on Vormex`,
        body: `It has been ${pluralizeDays(daysOnVormex)} on Vormex. ${growthZero ? 'Your growth is still quiet.' : 'You can still turn today into progress.'} Open the app and build something real tonight.`,
        campaignType: 'growth',
        data: {
          hook: 'days_on_vormex',
          daysOnVormex: String(daysOnVormex),
        },
      };
    case 'growth_zero':
      return {
        title: growthZero ? 'Your growth is still at 0 today' : 'Your next move still matters tonight',
        body: growthZero
          ? `No new posts. No new connections. No real movement yet. Open Vormex and make today count.`
          : `You already have momentum. Open Vormex now and push it one step further before the day ends.`,
        campaignType: 'growth',
        data: {
          hook: 'growth_zero',
          growthZero: String(growthZero),
        },
      };
    case 'real_growth':
      return {
        title: 'This is not just to connect',
        body: `Vormex is for real growth. Open the app, meet ${candidateReason}, and build something meaningful tonight.`,
        campaignType: 'growth',
        data: {
          hook: 'real_growth',
        },
      };
    case 'late_hour':
      return {
        title: '9 PM is still a good time to move',
        body: `You are not late. Open Vormex now and turn ${candidateReason} into one real step forward tonight.`,
        campaignType: 'growth',
        data: {
          hook: 'late_hour',
        },
      };
    case 'no_sleep':
      return {
        title: `Vormex doesn't sleep for your growth`,
        body: `If today stays idle, it stays idle. Open Vormex now and make one meaningful move before the night is gone.`,
        campaignType: 'growth',
        data: {
          hook: 'no_sleep',
        },
      };
    case 'final_call':
    default:
      if (highestStreak >= 2) {
        return {
          title: 'Last call before tonight closes',
          body: `Open Vormex now or your ${highestStreak}-day streak is in danger. One meaningful action is enough to keep it alive.`,
          campaignType: 'streak',
          data: {
            hook: 'final_call',
            streakCount: String(highestStreak),
          },
        };
      }

      return {
        title: 'One last push for today',
        body: `Open Vormex now. ${candidateReason} is still waiting, and today can still become something meaningful.`,
        campaignType: 'growth',
        data: {
          hook: 'final_call_fallback',
        },
      };
  }
}

function createEmptyGrowthSnapshot(): ReengagementGrowthSnapshot {
  return {
    acceptedConnections: 0,
    directMessages: 0,
    groupMessages: 0,
    postComments: 0,
    postsCreated: 0,
    reelComments: 0,
    reelsCreated: 0,
  };
}

export function getMeaningfulGrowthCount(snapshot: ReengagementGrowthSnapshot | null | undefined): number {
  if (!snapshot) {
    return 0;
  }

  return (
    snapshot.acceptedConnections +
    snapshot.directMessages +
    snapshot.groupMessages +
    snapshot.postComments +
    snapshot.postsCreated +
    snapshot.reelComments +
    snapshot.reelsCreated
  );
}

export function hasMeaningfulGrowth(snapshot: ReengagementGrowthSnapshot | null | undefined): boolean {
  return getMeaningfulGrowthCount(snapshot) > 0;
}

function createGrowthSnapshotMap(userIds: string[]): Map<string, ReengagementGrowthSnapshot> {
  const snapshotByUser = new Map<string, ReengagementGrowthSnapshot>();
  for (const userId of userIds) {
    snapshotByUser.set(userId, createEmptyGrowthSnapshot());
  }

  return snapshotByUser;
}

function incrementGrowthMetric(
  snapshotByUser: Map<string, ReengagementGrowthSnapshot>,
  userId: string,
  field: keyof ReengagementGrowthSnapshot,
  amount: number
): void {
  const snapshot = snapshotByUser.get(userId);
  if (!snapshot || amount <= 0) {
    return;
  }

  snapshot[field] += amount;
}

async function loadMeaningfulGrowthSnapshotMap(
  userIds: string[],
  activityWindowStartUtc: Date
): Promise<Map<string, ReengagementGrowthSnapshot>> {
  const snapshotByUser = createGrowthSnapshotMap(userIds);
  if (userIds.length === 0) {
    return snapshotByUser;
  }

  // Use source records with timestamps so IST-aligned re-engagement days are accurate.
  const [
    acceptedConnections,
    postsCreated,
    reelsCreated,
    postComments,
    reelComments,
    directMessages,
    groupMessages,
  ] = await Promise.all([
    prisma.connections.findMany({
      where: {
        status: 'accepted',
        updatedAt: { gte: activityWindowStartUtc },
        OR: [
          { requesterId: { in: userIds } },
          { addresseeId: { in: userIds } },
        ],
      },
      select: {
        addresseeId: true,
        requesterId: true,
      },
    }),
    prisma.post.groupBy({
      by: ['authorId'],
      where: {
        authorId: { in: userIds },
        createdAt: { gte: activityWindowStartUtc },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.reels.groupBy({
      by: ['authorId'],
      where: {
        authorId: { in: userIds },
        createdAt: { gte: activityWindowStartUtc },
        status: { not: 'draft' },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.post_comments.groupBy({
      by: ['authorId'],
      where: {
        authorId: { in: userIds },
        createdAt: { gte: activityWindowStartUtc },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.reel_comments.groupBy({
      by: ['authorId'],
      where: {
        authorId: { in: userIds },
        createdAt: { gte: activityWindowStartUtc },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.messages.groupBy({
      by: ['senderId'],
      where: {
        createdAt: { gte: activityWindowStartUtc },
        isDeleted: false,
        senderId: { in: userIds },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.group_messages.groupBy({
      by: ['senderId'],
      where: {
        createdAt: { gte: activityWindowStartUtc },
        isDeleted: false,
        senderId: { in: userIds },
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  for (const connection of acceptedConnections) {
    incrementGrowthMetric(snapshotByUser, connection.requesterId, 'acceptedConnections', 1);
    incrementGrowthMetric(snapshotByUser, connection.addresseeId, 'acceptedConnections', 1);
  }

  for (const row of postsCreated) {
    incrementGrowthMetric(snapshotByUser, row.authorId, 'postsCreated', row._count._all);
  }

  for (const row of reelsCreated) {
    incrementGrowthMetric(snapshotByUser, row.authorId, 'reelsCreated', row._count._all);
  }

  for (const row of postComments) {
    incrementGrowthMetric(snapshotByUser, row.authorId, 'postComments', row._count._all);
  }

  for (const row of reelComments) {
    incrementGrowthMetric(snapshotByUser, row.authorId, 'reelComments', row._count._all);
  }

  for (const row of directMessages) {
    incrementGrowthMetric(snapshotByUser, row.senderId, 'directMessages', row._count._all);
  }

  for (const row of groupMessages) {
    incrementGrowthMetric(snapshotByUser, row.senderId, 'groupMessages', row._count._all);
  }

  return snapshotByUser;
}

function scoreCandidate(
  currentUser: Pick<UserSnapshot, 'college' | 'user_onboarding'>,
  candidate: {
    college: string | null;
    id: string;
    lastActiveAt: Date | null;
    name: string | null;
    user_onboarding: {
      primaryGoal: string | null;
    } | null;
  }
): MatchCandidate {
  const currentGoal = getPrimaryGoalLabel(currentUser.user_onboarding?.primaryGoal);
  const candidateGoal = getPrimaryGoalLabel(candidate.user_onboarding?.primaryGoal);
  const currentCollege = normalizeText(currentUser.college)?.toLowerCase();
  const candidateCollege = normalizeText(candidate.college)?.toLowerCase();
  const sameGoal = Boolean(currentGoal && candidateGoal && currentGoal === candidateGoal);
  const sameCollege = Boolean(currentCollege && candidateCollege && currentCollege === candidateCollege);
  const isRecentlyActive = Boolean(
    candidate.lastActiveAt && Date.now() - candidate.lastActiveAt.getTime() < RECENTLY_ACTIVE_MS
  );

  let reason: MatchReason = 'recommended';
  if (sameGoal && sameCollege) reason = 'same_goal_same_college';
  else if (sameGoal) reason = 'same_goal';
  else if (sameCollege) reason = 'same_college';
  else if (isRecentlyActive) reason = 'active_builder';

  return {
    id: candidate.id,
    isRecentlyActive,
    name: normalizeText(candidate.name) || 'A builder on Vormex',
    primaryGoal: candidateGoal,
    reason,
    sameCollege,
    sameGoal,
  };
}

async function loadConnectedIds(userId: string): Promise<string[]> {
  const connections = await prisma.connections.findMany({
    where: {
      OR: [
        { requesterId: userId },
        { addresseeId: userId },
      ],
    },
    select: {
      addresseeId: true,
      requesterId: true,
    },
  });

  const ids = new Set<string>([userId]);
  for (const connection of connections) {
    ids.add(connection.requesterId);
    ids.add(connection.addresseeId);
  }

  return Array.from(ids);
}

async function findBestMatchCandidate(currentUser: UserSnapshot): Promise<MatchCandidate | null> {
  const connectedIds = await loadConnectedIds(currentUser.id);
  const currentGoal = getPrimaryGoalLabel(currentUser.user_onboarding?.primaryGoal);
  const targetWhere: any = {
    id: { notIn: connectedIds },
    isBanned: false,
  };

  const targetedOrClauses: any[] = [];
  if (currentGoal) {
    targetedOrClauses.push({
      user_onboarding: {
        is: {
          primaryGoal: currentGoal,
        },
      },
    });
  }

  if (normalizeText(currentUser.college)) {
    targetedOrClauses.push({
      college: currentUser.college,
    });
  }

  targetedOrClauses.push({
    lastActiveAt: {
      gte: new Date(Date.now() - RECENTLY_ACTIVE_MS),
    },
  });

  const matchPoolSize = parsePositiveInt(process.env.REENGAGEMENT_MATCH_POOL_SIZE, DEFAULT_MATCH_POOL_SIZE);

  let candidates = await prisma.user.findMany({
    where: {
      ...targetWhere,
      OR: targetedOrClauses,
    },
    select: {
      college: true,
      id: true,
      lastActiveAt: true,
      name: true,
      user_onboarding: {
        select: {
          primaryGoal: true,
        },
      },
    },
    take: matchPoolSize,
    orderBy: [
      { lastActiveAt: 'desc' },
      { createdAt: 'desc' },
    ],
  });

  if (candidates.length === 0) {
    candidates = await prisma.user.findMany({
      where: targetWhere,
      select: {
        college: true,
        id: true,
        lastActiveAt: true,
        name: true,
        user_onboarding: {
          select: {
            primaryGoal: true,
          },
        },
      },
      take: Math.max(6, Math.floor(matchPoolSize / 2)),
      orderBy: [
        { lastActiveAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates
    .map((candidate) => scoreCandidate(currentUser, candidate))
    .sort((left, right) => {
      const leftScore =
        (left.sameGoal ? 40 : 0) +
        (left.sameCollege ? 25 : 0) +
        (left.isRecentlyActive ? 10 : 0);
      const rightScore =
        (right.sameGoal ? 40 : 0) +
        (right.sameCollege ? 25 : 0) +
        (right.isRecentlyActive ? 10 : 0);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return left.name.localeCompare(right.name);
    });

  return scored[0] || null;
}

function getEligibleAudienceWhere(
  lookbackBoundary: Date
): Record<string, unknown> {
  return {
    OR: [
      { lastActiveAt: { gte: lookbackBoundary } },
      { createdAt: { gte: lookbackBoundary } },
    ],
    device_tokens: {
      some: {
        isActive: true,
      },
    },
    isBanned: false,
    isOnline: false,
  };
}

async function loadUserSnapshotById(userId: string): Promise<UserSnapshot | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      _count: {
        select: {
          posts: true,
        },
      },
      college: true,
      createdAt: true,
      engagement_streaks: {
        select: {
          connectionStreak: true,
          loginStreak: true,
          messagingStreak: true,
          postingStreak: true,
        },
      },
      id: true,
      isBanned: true,
      isOnline: true,
      lastActiveAt: true,
      name: true,
      user_onboarding: {
        select: {
          primaryGoal: true,
        },
      },
      userStats: {
        select: {
          connectionsCount: true,
          currentStreak: true,
          totalActiveDays: true,
          xp: true,
        },
      },
    },
  }) as Promise<UserSnapshot | null>;
}

function getCampaignDayContext(now: Date, window: ReturnType<typeof getCurrentReengagementWindow>) {
  return {
    activityWindowStartUtc: window.activityWindowStartUtc || getIstStartOfDayUtc(now),
    campaignDateKey: window.slotDateKey || formatDateKey(now),
  };
}

function isUserWithinLookback(user: UserSnapshot, lookbackBoundary: Date): boolean {
  return Boolean(
    (user.lastActiveAt && user.lastActiveAt >= lookbackBoundary) ||
    user.createdAt >= lookbackBoundary
  );
}

async function getActiveDeviceTokenState(userId: string): Promise<boolean> {
  const token = await prisma.device_tokens.findFirst({
    where: {
      isActive: true,
      userId,
    },
    select: { id: true },
  });

  return Boolean(token);
}

function serializeUserPreview(user: UserSnapshot | null) {
  if (!user) {
    return null;
  }

  return {
    college: user.college,
    createdAt: user.createdAt,
    id: user.id,
    isBanned: user.isBanned,
    isOnline: user.isOnline,
    lastActiveAt: user.lastActiveAt,
    name: user.name,
    primaryGoal: user.user_onboarding?.primaryGoal || null,
  };
}

async function findExistingDeliveryStatus(
  userId: string,
  campaignDateKey: string,
  slotKey: string | null
): Promise<string | null> {
  if (!slotKey) {
    return null;
  }

  const existingDelivery = await prisma.reengagement_notification_deliveries.findUnique({
    where: {
      userId_campaignDateKey_slotKey: {
        campaignDateKey,
        slotKey,
        userId,
      },
    },
    select: {
      status: true,
    },
  });

  return existingDelivery?.status || null;
}

export async function previewReengagementForUser(
  userId: string,
  now: Date = new Date()
): Promise<ReengagementAdminPreviewResult> {
  const window = getCurrentReengagementWindow(now);
  const campaignDayContext = getCampaignDayContext(now, window);

  if (!isReengagementEnabled()) {
    return {
      candidate: null,
      copy: null,
      currentIstHour: window.currentIstHour,
      eligible: false,
      enabled: false,
      existingDeliveryStatus: null,
      growthSnapshot: createEmptyGrowthSnapshot(),
      hasActiveDeviceToken: false,
      hasMeaningfulGrowthToday: false,
      highestStreak: 0,
      meaningfulGrowthCount: 0,
      reason: 'reengagement_disabled',
      sendAttempted: false,
      sent: false,
      slotDateKey: window.slotDateKey,
      slotKey: window.slot?.key || null,
      user: null,
    };
  }

  const user = await loadUserSnapshotById(userId);
  if (!user) {
    return {
      candidate: null,
      copy: null,
      currentIstHour: window.currentIstHour,
      eligible: false,
      enabled: true,
      existingDeliveryStatus: null,
      growthSnapshot: createEmptyGrowthSnapshot(),
      hasActiveDeviceToken: false,
      hasMeaningfulGrowthToday: false,
      highestStreak: 0,
      meaningfulGrowthCount: 0,
      reason: 'user_not_found',
      sendAttempted: false,
      sent: false,
      slotDateKey: campaignDayContext.campaignDateKey,
      slotKey: window.slot?.key || null,
      user: null,
    };
  }

  const lookbackDays = parsePositiveInt(process.env.REENGAGEMENT_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS);
  const lookbackBoundary = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const growthSnapshotByUser = await loadMeaningfulGrowthSnapshotMap([userId], campaignDayContext.activityWindowStartUtc);
  const growthSnapshot = growthSnapshotByUser.get(userId) || createEmptyGrowthSnapshot();
  const meaningfulGrowthCount = getMeaningfulGrowthCount(growthSnapshot);
  const hasActiveDeviceToken = await getActiveDeviceTokenState(userId);
  const highestStreak = getHighestTrackedStreak(user);
  const existingDeliveryStatus = await findExistingDeliveryStatus(
    userId,
    campaignDayContext.campaignDateKey,
    window.slot?.key || null
  );

  const candidate = window.slot ? await findBestMatchCandidate(user) : null;
  const currentUser = {
    college: user.college,
    connectionsCount: user.userStats?.connectionsCount || 0,
    createdAt: user.createdAt,
    meaningfulGrowthCount,
    postsCount: user._count.posts || 0,
    totalActiveDays: user.userStats?.totalActiveDays || 0,
    user_onboarding: user.user_onboarding,
  };
  const copy = window.slot
    ? buildReengagementCopy({
        candidate,
        currentUser,
        highestStreak,
        slot: window.slot,
      })
    : null;

  let reason: ReengagementAdminPreviewResult['reason'] = 'eligible';
  let eligible = true;

  if (!window.slot || !window.slotDateKey || !window.activityWindowStartUtc) {
    reason = 'outside_slot_window';
    eligible = false;
  } else if (user.isBanned) {
    reason = 'user_banned';
    eligible = false;
  } else if (user.isOnline) {
    reason = 'user_online';
    eligible = false;
  } else if (!hasActiveDeviceToken) {
    reason = 'no_active_device_token';
    eligible = false;
  } else if (!isUserWithinLookback(user, lookbackBoundary)) {
    reason = 'outside_lookback_window';
    eligible = false;
  } else if (hasMeaningfulGrowth(growthSnapshot)) {
    reason = 'already_grew_today';
    eligible = false;
  } else if (existingDeliveryStatus === 'sent') {
    reason = 'already_sent_for_slot';
    eligible = false;
  }

  return {
    candidate,
    copy,
    currentIstHour: window.currentIstHour,
    eligible,
    enabled: true,
    existingDeliveryStatus,
    growthSnapshot,
    hasActiveDeviceToken,
    hasMeaningfulGrowthToday: hasMeaningfulGrowth(growthSnapshot),
    highestStreak,
    meaningfulGrowthCount,
    reason,
    sendAttempted: false,
    sent: false,
    slotDateKey: campaignDayContext.campaignDateKey,
    slotKey: window.slot?.key || null,
    user: serializeUserPreview(user),
  };
}

export async function runReengagementForUser(
  userId: string,
  now: Date = new Date()
): Promise<ReengagementAdminPreviewResult> {
  const preview = await previewReengagementForUser(userId, now);
  if (!preview.eligible || !preview.slotDateKey || !preview.slotKey) {
    return preview;
  }

  const user = await loadUserSnapshotById(userId);
  const slot = getCurrentReengagementWindow(now).slot;
  if (!user || !slot) {
    return {
      ...preview,
      eligible: false,
      reason: user ? 'outside_slot_window' : 'user_not_found',
    };
  }

  const growthSnapshotByUser = await loadMeaningfulGrowthSnapshotMap(
    [userId],
    getCampaignDayContext(now, getCurrentReengagementWindow(now)).activityWindowStartUtc
  );

  const outcome = await processUserForSlot(
    user,
    slot,
    preview.slotDateKey,
    growthSnapshotByUser.get(userId)
  );

  const updatedPreview = await previewReengagementForUser(userId, now);
  return {
    ...updatedPreview,
    sendAttempted: true,
    sent: outcome === 'sent',
  };
}

export function getCurrentReengagementWindow(now: Date = new Date()): {
  activityWindowStartUtc: Date | null;
  currentIstHour: number;
  slot: ConfiguredSlot | null;
  slotDateKey: string | null;
} {
  const shifted = shiftToIst(now);
  const currentIstHour = shifted.getUTCHours();
  const slots = getConfiguredReengagementSlots();
  const slot = slots.find((item) => item.hourIst === currentIstHour) || null;

  if (!slot) {
    return {
      activityWindowStartUtc: null,
      currentIstHour,
      slot: null,
      slotDateKey: null,
    };
  }

  const campaignAnchor = slot.isRolloverFinalSlot ? addDays(now, -1) : now;

  return {
    activityWindowStartUtc: getIstStartOfDayUtc(campaignAnchor),
    currentIstHour,
    slot,
    slotDateKey: formatDateKey(campaignAnchor),
  };
}

async function reserveDelivery(
  userId: string,
  slot: ConfiguredSlot,
  slotDateKey: string,
  copy: ReengagementCopy
) {
  const existing = await prisma.reengagement_notification_deliveries.findUnique({
    where: {
      userId_campaignDateKey_slotKey: {
        campaignDateKey: slotDateKey,
        slotKey: slot.key,
        userId,
      },
    },
  });

  if (existing?.status === 'sent') {
    return null;
  }

  if (existing) {
    return prisma.reengagement_notification_deliveries.update({
      where: { id: existing.id },
      data: {
        body: copy.body,
        campaignType: copy.campaignType,
        payload: copy.data,
        reason: null,
        sentAt: null,
        slotHour: slot.hourIst,
        status: 'pending',
        title: copy.title,
      },
    });
  }

  return prisma.reengagement_notification_deliveries.create({
    data: {
      body: copy.body,
      campaignDateKey: slotDateKey,
      campaignType: copy.campaignType,
      payload: copy.data,
      slotHour: slot.hourIst,
      slotKey: slot.key,
      status: 'pending',
      title: copy.title,
      userId,
    },
  });
}

async function processUserForSlot(
  user: UserSnapshot,
  slot: ConfiguredSlot,
  slotDateKey: string,
  growthSnapshot: ReengagementGrowthSnapshot | null | undefined
): Promise<'sent' | 'failed' | 'skipped'> {
  if (hasMeaningfulGrowth(growthSnapshot)) {
    return 'skipped';
  }

  const currentUser = {
    college: user.college,
    connectionsCount: user.userStats?.connectionsCount || 0,
    createdAt: user.createdAt,
    meaningfulGrowthCount: getMeaningfulGrowthCount(growthSnapshot),
    postsCount: user._count.posts || 0,
    totalActiveDays: user.userStats?.totalActiveDays || 0,
    user_onboarding: user.user_onboarding,
  };
  const candidate = await findBestMatchCandidate(user);
  const highestStreak = getHighestTrackedStreak(user);
  const copy = buildReengagementCopy({
    candidate,
    currentUser,
    highestStreak,
    slot,
  });

  const delivery = await reserveDelivery(user.id, slot, slotDateKey, copy);
  if (!delivery) {
    return 'skipped';
  }

  const payloadData: Record<string, string> = {
    campaignDate: slotDateKey,
    campaignKind: 'reengagement',
    campaignSlot: slot.key,
    campaignType: copy.campaignType,
    ...copy.data,
  };

  if (candidate?.id) {
    payloadData.matchUserId = candidate.id;
    payloadData.matchReason = candidate.reason;
  }

  const sent = await pushNotificationService.pushReengagementNudge(user.id, {
    body: copy.body,
    campaignType: copy.campaignType,
    data: payloadData,
    title: copy.title,
  });

  await prisma.reengagement_notification_deliveries.update({
    where: { id: delivery.id },
    data: sent
      ? {
          reason: null,
          sentAt: new Date(),
          status: 'sent',
        }
      : {
          reason: 'push_not_sent',
          status: 'failed',
        },
  });

  return sent ? 'sent' : 'failed';
}

export async function runReengagementCampaign(now: Date = new Date()): Promise<ReengagementRunResult> {
  const window = getCurrentReengagementWindow(now);

  if (!isReengagementEnabled() || !window.slot || !window.slotDateKey || !window.activityWindowStartUtc) {
    return {
      currentIstHour: window.currentIstHour,
      failed: 0,
      processed: 0,
      sent: 0,
      skipped: 0,
      slotKey: null,
    };
  }

  const lookbackDays = parsePositiveInt(process.env.REENGAGEMENT_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS);
  const lookbackBoundary = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: getEligibleAudienceWhere(lookbackBoundary) as any,
    select: {
      _count: {
        select: {
          posts: true,
        },
      },
      college: true,
      createdAt: true,
      engagement_streaks: {
        select: {
          connectionStreak: true,
          loginStreak: true,
          messagingStreak: true,
          postingStreak: true,
        },
      },
      id: true,
      isBanned: true,
      lastActiveAt: true,
      name: true,
      user_onboarding: {
        select: {
          primaryGoal: true,
        },
      },
      userStats: {
        select: {
          connectionsCount: true,
          currentStreak: true,
          totalActiveDays: true,
          xp: true,
        },
      },
    },
  });

  const growthSnapshotByUser = await loadMeaningfulGrowthSnapshotMap(
    users.map((user) => user.id),
    window.activityWindowStartUtc
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const batchSize = 8;
  for (let index = 0; index < users.length; index += batchSize) {
    const batch = users.slice(index, index + batchSize);
    const results = await Promise.allSettled(
      batch.map((user) =>
        processUserForSlot(
          user as UserSnapshot,
          window.slot as ConfiguredSlot,
          window.slotDateKey as string,
          growthSnapshotByUser.get(user.id)
        )
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'sent') sent += 1;
        else if (result.value === 'failed') failed += 1;
        else skipped += 1;
        continue;
      }

      failed += 1;
      console.error('[ReengagementCampaign] Failed to process user slot:', result.reason);
    }
  }

  return {
    currentIstHour: window.currentIstHour,
    failed,
    processed: users.length,
    sent,
    skipped,
    slotKey: window.slot.key,
  };
}
