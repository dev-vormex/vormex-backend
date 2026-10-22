import { prisma } from "../../../../config/prisma";
import { UserSnapshot, MatchCandidate, getPrimaryGoalLabel, normalizeText, RECENTLY_ACTIVE_MS, parsePositiveInt, DEFAULT_MATCH_POOL_SIZE, getIstStartOfDayUtc, formatDateKey, ReengagementAdminPreviewResult, isReengagementEnabled, DEFAULT_LOOKBACK_DAYS, getHighestTrackedStreak } from "./parse-reengagement-hours.service";
import { loadConnectedIds, scoreCandidate, createEmptyGrowthSnapshot, loadMeaningfulGrowthSnapshotMap, getMeaningfulGrowthCount, buildReengagementCopy, hasMeaningfulGrowth } from "./build-reengagement-copy.service";
import { getCurrentReengagementWindow } from "./get-current-reengagement-window.service";

export async function findBestMatchCandidate(currentUser: UserSnapshot): Promise<MatchCandidate | null> {
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

export function getEligibleAudienceWhere(
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

export async function loadUserSnapshotById(userId: string): Promise<UserSnapshot | null> {
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

export function getCampaignDayContext(now: Date, window: ReturnType<typeof getCurrentReengagementWindow>) {
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
