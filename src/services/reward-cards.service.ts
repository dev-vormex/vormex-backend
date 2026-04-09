import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';

export const REWARD_CARD_SURFACE = 'app_open_overlay';

export const REWARD_CARD_ACTIONS = [
  'shown',
  'skipped',
  'opened_profile',
  'connected',
  'dismissed_all',
] as const;

export const REWARD_CARD_TYPES = ['daily_match', 'hidden_gem'] as const;

export type RewardCardAction = (typeof REWARD_CARD_ACTIONS)[number];
export type RewardCardType = (typeof REWARD_CARD_TYPES)[number];

export interface RewardCardDto {
  id: string;
  cardType: RewardCardType;
  name: string;
  profileImage: string | null;
  headline: string | null;
  primaryReason: string;
  secondaryMeta: string;
  isOnline: boolean;
  badge: string | null;
}

export interface RewardCardsResponseDto {
  sessionId: string;
  count: number;
  cards: RewardCardDto[];
}

export interface RewardCardEventInput {
  userId: string;
  sessionId: string;
  action: RewardCardAction;
  cardId?: string | null;
  cardType?: RewardCardType | null;
}

type CurrentUserContext = {
  college: string | null;
  interests: string[];
  user_onboarding: {
    primaryGoal: string | null;
  } | null;
};

type CandidateRecord = {
  id: string;
  name: string | null;
  profileImage: string | null;
  headline: string | null;
  bio: string | null;
  college: string | null;
  interests: string[];
  lastActiveAt: Date | null;
  user_onboarding: {
    primaryGoal: string | null;
  } | null;
  userStats: {
    connectionsCount: number;
    followersCount: number;
  } | null;
};

type ScoredCandidate = {
  id: string;
  name: string;
  profileImage: string | null;
  headline: string | null;
  college: string | null;
  primaryReason: string;
  secondaryMeta: string;
  isOnline: boolean;
  finalScore: number;
  lastShownAt: Date | null;
  isHiddenGemEligible: boolean;
};

const MAX_OVERLAY_CARDS = 3;
const CANDIDATE_POOL_SIZE = 200;
const BACKFILL_SHOWN_BLOCK_MS = 2 * 60 * 60 * 1000;
const PRIMARY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_NOW_MS = 60 * 60 * 1000;
const ACTIVE_TODAY_MS = 24 * 60 * 60 * 1000;
const ONLINE_MS = 5 * 60 * 1000;

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeInterest(value: string): string {
  return value.trim().toLowerCase();
}

function countSharedInterests(current: string[], candidate: string[]): number {
  const currentSet = new Set(current.map(normalizeInterest).filter(Boolean));
  if (currentSet.size === 0) return 0;

  let overlap = 0;
  const seen = new Set<string>();
  for (const item of candidate.map(normalizeInterest)) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (currentSet.has(item)) {
      overlap += 1;
    }
  }

  return overlap;
}

function hasProfileQuality(candidate: CandidateRecord): boolean {
  let completedFields = 0;
  if (nonEmpty(candidate.profileImage)) completedFields += 1;
  if (nonEmpty(candidate.headline)) completedFields += 1;
  if (nonEmpty(candidate.bio)) completedFields += 1;
  if (nonEmpty(candidate.college)) completedFields += 1;
  if ((candidate.interests || []).length > 0) completedFields += 1;
  return completedFields >= 4;
}

function hasNetworkQuality(candidate: CandidateRecord): boolean {
  const connectionsCount = candidate.userStats?.connectionsCount ?? 0;
  const followersCount = candidate.userStats?.followersCount ?? 0;
  return connectionsCount >= 5 || followersCount >= 10;
}

function deriveSecondaryMeta(lastActiveAt: Date | null, nowMs: number): string {
  if (!lastActiveAt) return 'Recently active';
  const diffMs = Math.max(0, nowMs - lastActiveAt.getTime());

  if (diffMs < ACTIVE_NOW_MS) return 'Active now';
  if (diffMs < ACTIVE_TODAY_MS) return 'Active today';
  return 'Recently active';
}

function derivePrimaryReason(
  sameGoal: boolean,
  sameCollege: boolean,
  sharedInterestCount: number,
  activeToday: boolean,
  profileQuality: boolean,
  networkQuality: boolean
): string {
  if (sameGoal) return 'Same goal';
  if (sameCollege) return 'Same college';
  if (sharedInterestCount > 0) {
    return `${sharedInterestCount} shared interest${sharedInterestCount > 1 ? 's' : ''}`;
  }
  if (activeToday) return 'Active today';
  if (profileQuality) return 'Strong profile';
  if (networkQuality) return 'Well connected';
  return 'Recommended for you';
}

function scoreCandidate(candidate: CandidateRecord, currentUser: CurrentUserContext, nowMs: number): ScoredCandidate {
  const sameGoal =
    nonEmpty(currentUser.user_onboarding?.primaryGoal) &&
    currentUser.user_onboarding?.primaryGoal === candidate.user_onboarding?.primaryGoal;
  const sameCollege =
    nonEmpty(currentUser.college) &&
    currentUser.college?.trim().toLowerCase() === candidate.college?.trim().toLowerCase();
  const sharedInterestCount = countSharedInterests(currentUser.interests || [], candidate.interests || []);
  const sharedInterestScore = Math.min(sharedInterestCount * 10, 30);
  const activeToday =
    !!candidate.lastActiveAt && nowMs - candidate.lastActiveAt.getTime() < ACTIVE_TODAY_MS;
  const profileQuality = hasProfileQuality(candidate);
  const networkQuality = hasNetworkQuality(candidate);

  let baseScore = 0;
  if (sameGoal) baseScore += 35;
  if (sameCollege) baseScore += 25;
  baseScore += sharedInterestScore;
  if (activeToday) baseScore += 10;
  if (profileQuality) baseScore += 10;
  if (networkQuality) baseScore += 5;

  const explorationScore = Math.random() * 10;
  const primaryReason = derivePrimaryReason(
    sameGoal,
    sameCollege,
    sharedInterestCount,
    activeToday,
    profileQuality,
    networkQuality
  );

  return {
    id: candidate.id,
    name: candidate.name?.trim() || 'Vormex member',
    profileImage: candidate.profileImage,
    headline: candidate.headline,
    college: candidate.college,
    primaryReason,
    secondaryMeta: deriveSecondaryMeta(candidate.lastActiveAt, nowMs),
    isOnline: !!candidate.lastActiveAt && nowMs - candidate.lastActiveAt.getTime() < ONLINE_MS,
    finalScore: baseScore + explorationScore,
    lastShownAt: null,
    isHiddenGemEligible: profileQuality && (candidate.userStats?.connectionsCount ?? 0) >= 10,
  };
}

function sortScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.finalScore !== a.finalScore) {
    return b.finalScore - a.finalScore;
  }

  const bTime = b.lastShownAt?.getTime() ?? 0;
  const aTime = a.lastShownAt?.getTime() ?? 0;
  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return a.name.localeCompare(b.name);
}

function appendDiversifiedCandidates(
  selected: ScoredCandidate[],
  source: ScoredCandidate[],
  limit: number
): ScoredCandidate[] {
  const result = [...selected];
  const remaining = [...source];

  while (result.length < limit && remaining.length > 0) {
    const usedReasons = new Set(result.map((candidate) => candidate.primaryReason));
    const usedColleges = new Set(
      result
        .map((candidate) => candidate.college?.trim().toLowerCase())
        .filter((value): value is string => !!value)
    );

    const tierOne = remaining.filter((candidate) => {
      const normalizedCollege = candidate.college?.trim().toLowerCase();
      const hasFreshCollege = !normalizedCollege || !usedColleges.has(normalizedCollege);
      return !usedReasons.has(candidate.primaryReason) && hasFreshCollege;
    });

    const tierTwo = remaining.filter((candidate) => !usedReasons.has(candidate.primaryReason));
    const tierThree = remaining;
    const nextPool = tierOne.length > 0 ? tierOne : tierTwo.length > 0 ? tierTwo : tierThree;
    const nextCandidate = nextPool[0];

    result.push(nextCandidate);
    const nextIndex = remaining.findIndex((candidate) => candidate.id == nextCandidate.id);
    if (nextIndex >= 0) {
      remaining.splice(nextIndex, 1);
    }
  }

  return result;
}

async function loadCurrentUserContext(userId: string): Promise<CurrentUserContext> {
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      college: true,
      interests: true,
      user_onboarding: {
        select: { primaryGoal: true },
      },
    },
  });

  if (!currentUser) {
    throw new Error('User not found');
  }

  return currentUser;
}

async function loadBlockedUserIds(userId: string): Promise<Set<string>> {
  const blockedConnections = await prisma.connections.findMany({
    where: {
      status: { in: ['pending', 'accepted'] },
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: {
      requesterId: true,
      addresseeId: true,
    },
  });

  const blockedUserIds = new Set<string>([userId]);
  for (const connection of blockedConnections) {
    blockedUserIds.add(connection.requesterId);
    blockedUserIds.add(connection.addresseeId);
  }

  return blockedUserIds;
}

async function loadCandidatePool(excludedIds: string[]): Promise<CandidateRecord[]> {
  return prisma.user.findMany({
    where: {
      id: { notIn: excludedIds },
      isBanned: false,
    },
    take: CANDIDATE_POOL_SIZE,
    orderBy: [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      profileImage: true,
      headline: true,
      bio: true,
      college: true,
      interests: true,
      lastActiveAt: true,
      user_onboarding: {
        select: { primaryGoal: true },
      },
      userStats: {
        select: {
          connectionsCount: true,
          followersCount: true,
        },
      },
    },
  });
}

export async function getRewardCardsForUser(userId: string): Promise<RewardCardsResponseDto> {
  const sessionId = randomUUID();
  const nowMs = Date.now();
  const sevenDaysAgo = new Date(nowMs - PRIMARY_COOLDOWN_MS);
  const backfillShownCutoff = new Date(nowMs - BACKFILL_SHOWN_BLOCK_MS);

  const [currentUser, blockedUserIds] = await Promise.all([
    loadCurrentUserContext(userId),
    loadBlockedUserIds(userId),
  ]);

  const candidatePool = await loadCandidatePool(Array.from(blockedUserIds));
  if (candidatePool.length === 0) {
    return {
      sessionId,
      count: 0,
      cards: [],
    };
  }

  const candidateIds = candidatePool.map((candidate) => candidate.id);
  const [recentEvents, shownHistory] = await Promise.all([
    prisma.reward_card_events.findMany({
      where: {
        userId,
        surface: REWARD_CARD_SURFACE,
        candidateUserId: { in: candidateIds },
        action: { in: ['shown', 'skipped'] },
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        candidateUserId: true,
        action: true,
        createdAt: true,
      },
    }),
    prisma.reward_card_events.findMany({
      where: {
        userId,
        surface: REWARD_CARD_SURFACE,
        candidateUserId: { in: candidateIds },
        action: 'shown',
      },
      orderBy: { createdAt: 'asc' },
      select: {
        candidateUserId: true,
        createdAt: true,
      },
    }),
  ]);

  const recentlyShownIds = new Set<string>();
  const recentlySkippedIds = new Set<string>();
  for (const event of recentEvents) {
    if (!event.candidateUserId) continue;
    if (event.action === 'shown') {
      recentlyShownIds.add(event.candidateUserId);
    }
    if (event.action === 'skipped') {
      recentlySkippedIds.add(event.candidateUserId);
    }
  }

  const lastShownAtByCandidate = new Map<string, Date>();
  for (const event of shownHistory) {
    if (!event.candidateUserId) continue;
    lastShownAtByCandidate.set(event.candidateUserId, event.createdAt);
  }

  const scoredCandidates = candidatePool
    .map((candidate) => {
      const scored = scoreCandidate(candidate, currentUser, nowMs);
      scored.lastShownAt = lastShownAtByCandidate.get(candidate.id) ?? null;
      return scored;
    })
    .sort(sortScoredCandidates);

  const primaryPool = scoredCandidates.filter(
    (candidate) => !recentlyShownIds.has(candidate.id) && !recentlySkippedIds.has(candidate.id)
  );

  let selected = appendDiversifiedCandidates([], primaryPool, MAX_OVERLAY_CARDS);

  if (selected.length < MAX_OVERLAY_CARDS) {
    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    const backfillPool = scoredCandidates
      .filter((candidate) => {
        if (selectedIds.has(candidate.id)) return false;
        if (recentlySkippedIds.has(candidate.id)) return false;
        if (!candidate.lastShownAt) return false;
        return candidate.lastShownAt.getTime() <= backfillShownCutoff.getTime();
      })
      .sort((a, b) => {
        const aTime = a.lastShownAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.lastShownAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (aTime !== bTime) {
          return aTime - bTime;
        }
        return sortScoredCandidates(a, b);
      });

    selected = appendDiversifiedCandidates(selected, backfillPool, MAX_OVERLAY_CARDS);
  }

  const hiddenGemId = selected.find((candidate) => candidate.isHiddenGemEligible)?.id ?? null;
  const cards = selected.map<RewardCardDto>((candidate) => ({
    id: candidate.id,
    cardType: candidate.id === hiddenGemId ? 'hidden_gem' : 'daily_match',
    name: candidate.name,
    profileImage: candidate.profileImage,
    headline: candidate.headline,
    primaryReason: candidate.primaryReason,
    secondaryMeta: candidate.secondaryMeta,
    isOnline: candidate.isOnline,
    badge: candidate.id === hiddenGemId ? 'Hidden gem' : null,
  }));

  return {
    sessionId,
    count: cards.length,
    cards,
  };
}

export async function logRewardCardEvent(input: RewardCardEventInput): Promise<void> {
  const now = new Date();

  if (input.action === 'dismissed_all') {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "reward_card_events" (
          "id",
          "user_id",
          "candidate_user_id",
          "session_id",
          "surface",
          "card_type",
          "action",
          "created_at"
        )
        VALUES (
          ${randomUUID()},
          ${input.userId},
          ${null},
          ${input.sessionId},
          ${REWARD_CARD_SURFACE},
          ${null},
          ${input.action},
          ${now}
        )
        ON CONFLICT ("user_id", "session_id", "action")
        WHERE "candidate_user_id" IS NULL
        DO NOTHING
      `
    );
    return;
  }

  if (!input.cardId || !input.cardType) {
    throw new Error('cardId and cardType are required for candidate events');
  }

  await prisma.$executeRaw(
    Prisma.sql`
      INSERT INTO "reward_card_events" (
        "id",
        "user_id",
        "candidate_user_id",
        "session_id",
        "surface",
        "card_type",
        "action",
        "created_at"
      )
      VALUES (
        ${randomUUID()},
        ${input.userId},
        ${input.cardId},
        ${input.sessionId},
        ${REWARD_CARD_SURFACE},
        ${input.cardType},
        ${input.action},
        ${now}
      )
      ON CONFLICT ("user_id", "candidate_user_id", "session_id", "action")
      WHERE "candidate_user_id" IS NOT NULL
      DO NOTHING
    `
  );
}
