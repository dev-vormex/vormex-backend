import { prisma } from "../../../../config/prisma";
import { ReengagementCopyInput, ReengagementCopy, getPrimaryGoalLabel, normalizeText, getDaysOnVormex, describeCandidateReason, pluralizeDays, ReengagementGrowthSnapshot, UserSnapshot, MatchCandidate, RECENTLY_ACTIVE_MS, MatchReason } from "./parse-reengagement-hours.service";

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

export function createEmptyGrowthSnapshot(): ReengagementGrowthSnapshot {
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

export async function loadMeaningfulGrowthSnapshotMap(
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

export function scoreCandidate(
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

export async function loadConnectedIds(userId: string): Promise<string[]> {
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
