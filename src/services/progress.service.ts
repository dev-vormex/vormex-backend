import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

export type ProgressCurrency = 'XP' | 'COINS';

export const XP_EARNING_RULES = [
  { action: 'Post', amount: 20, description: 'Publish a post' },
  { action: 'Article', amount: 35, description: 'Publish an article' },
  { action: 'Short video', amount: 30, description: 'Publish a reel or short video' },
  { action: 'Comment', amount: 5, description: 'Join a conversation' },
  { action: 'Connection', amount: 25, description: 'Accept a connection request' },
  { action: 'Message', amount: 1, description: 'Send a message, capped at 20 XP per day' },
  { action: 'Games', amount: null, description: 'Earn the reward shown when you win or complete a game' },
];

export const COIN_RULES = [
  { action: 'Games', description: 'Game rewards grant matching Coins when completed or won' },
  { action: 'Store', description: 'Spend Coins on store items and streak freezes' },
];

export const STREAK_RULES = [
  'Preserve your Daily Activity Streak with at least one meaningful action each UTC day.',
  'Meaningful actions include posting, commenting, accepting connections, messaging, and completed games.',
  'Login alone keeps the login category streak, but it does not preserve the main Daily Activity Streak.',
];

export const ACTIVITY_XP_REWARD: Partial<Record<string, number>> = {
  post: 20,
  article: 35,
  short_video: 30,
  comment: 5,
  connection: 25,
  message: 1,
};

const MESSAGE_DAILY_XP_CAP = 20;
const MEANINGFUL_ACTIVITY_TYPES = new Set([
  'post',
  'article',
  'short_video',
  'comment',
  'connection',
  'message',
  'forum_question',
  'forum_answer',
  'game',
]);

function startOfUtcDay(date = new Date()): Date {
  const next = new Date(date);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

function sameUtcDay(left: Date | null | undefined, right = new Date()): boolean {
  if (!left) return false;
  return startOfUtcDay(left).getTime() === startOfUtcDay(right).getTime();
}

export function isMeaningfulActivity(activityType: string): boolean {
  return MEANINGFUL_ACTIVITY_TYPES.has(activityType);
}

export function xpForLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 1) return 0;
  return Math.round(100 * Math.pow(level - 1, 1.35));
}

export function levelNameForLevel(level: number): string {
  if (level >= 100) return 'Legend';
  if (level >= 75) return 'Master';
  if (level >= 50) return 'Expert';
  if (level >= 35) return 'Pro';
  if (level >= 20) return 'Specialist';
  if (level >= 10) return 'Connector';
  if (level >= 5) return 'Builder';
  return 'Explorer';
}

export function calculateLevelProgress(lifetimeXp: number) {
  const safeXp = Math.max(0, Math.floor(lifetimeXp || 0));
  let level = 1;

  while (safeXp >= xpForLevel(level + 1)) {
    level += 1;
  }

  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const xpIntoLevel = safeXp - currentLevelXp;
  const xpToNextLevel = Math.max(0, nextLevelXp - safeXp);
  const levelSpan = Math.max(1, nextLevelXp - currentLevelXp);

  return {
    lifetimeXp: safeXp,
    level,
    levelName: levelNameForLevel(level),
    currentLevelXp,
    nextLevelXp,
    xpIntoLevel,
    xpToNextLevel,
    progressToNextLevel: Math.min(1, Math.max(0, xpIntoLevel / levelSpan)),
  };
}

async function sumLedgerXp(userId: string): Promise<number> {
  const result = await prisma.xp_transactions.aggregate({
    where: {
      userId,
      amount: { gt: 0 },
      currency: 'XP',
    },
    _sum: { amount: true },
  });

  return result._sum.amount || 0;
}

export async function getLifetimeXp(userId: string): Promise<number> {
  const [stats, ledgerXp] = await Promise.all([
    prisma.userStats.findUnique({
      where: { userId },
      select: { xp: true },
    }),
    sumLedgerXp(userId),
  ]);

  return Math.max(stats?.xp || 0, ledgerXp);
}

async function ensureStatsXp(userId: string, lifetimeXp: number) {
  const level = calculateLevelProgress(lifetimeXp).level;

  return prisma.userStats.upsert({
    where: { userId },
    create: {
      userId,
      xp: lifetimeXp,
      level,
    },
    update: {
      xp: lifetimeXp,
      level,
    },
  });
}

async function incrementStatsXp(userId: string, xpAmount: number) {
  const stats = await prisma.userStats.findUnique({
    where: { userId },
    select: { xp: true },
  });
  const lifetimeXp = stats ? stats.xp + xpAmount : await sumLedgerXp(userId);
  return ensureStatsXp(userId, lifetimeXp);
}

async function markMeaningfulStreakActivity(userId: string, date = new Date()) {
  const day = startOfUtcDay(date);

  await prisma.userDailyActivity.upsert({
    where: {
      userId_date: {
        userId,
        date: day,
      },
    },
    create: {
      userId,
      date: day,
      isActive: true,
    },
    update: {
      isActive: true,
    },
  });
}

async function isAlreadyAwarded(idempotencyKey?: string): Promise<boolean> {
  if (!idempotencyKey) return false;

  const existing = await prisma.xp_transactions.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });

  return Boolean(existing);
}

async function createProgressTransaction(input: {
  userId: string;
  amount: number;
  type: string;
  source: string;
  sourceId?: string | null;
  description?: string;
  currency: ProgressCurrency;
  countsForStreak: boolean;
  idempotencyKey?: string;
}) {
  if (await isAlreadyAwarded(input.idempotencyKey)) {
    return false;
  }

  try {
    await prisma.xp_transactions.create({
      data: {
        userId: input.userId,
        amount: input.amount,
        type: input.type,
        source: input.source,
        sourceId: input.sourceId || undefined,
        description: input.description,
        currency: input.currency,
        countsForStreak: input.countsForStreak,
        idempotencyKey: input.idempotencyKey,
      },
    });

    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return false;
    }

    throw error;
  }
}

export async function awardUserProgress(input: {
  userId: string;
  xpAmount?: number;
  coinAmount?: number;
  type: string;
  source: string;
  sourceId?: string | null;
  description?: string;
  countsForStreak?: boolean;
  idempotencyKey?: string;
}) {
  const xpAmount = Math.max(0, Math.floor(input.xpAmount || 0));
  const coinAmount = Math.max(0, Math.floor(input.coinAmount || 0));
  const countsForStreak = Boolean(input.countsForStreak);
  let xpAwarded = false;
  let coinsAwarded = false;

  if (xpAmount > 0) {
    xpAwarded = await createProgressTransaction({
      userId: input.userId,
      amount: xpAmount,
      type: input.type,
      source: input.source,
      sourceId: input.sourceId,
      description: input.description,
      currency: 'XP',
      countsForStreak,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:xp` : undefined,
    });
  }

  if (coinAmount > 0) {
    coinsAwarded = await createProgressTransaction({
      userId: input.userId,
      amount: coinAmount,
      type: input.type,
      source: input.source,
      sourceId: input.sourceId,
      description: input.description,
      currency: 'COINS',
      countsForStreak,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:coins` : undefined,
    });
  }

  if (xpAwarded) {
    await incrementStatsXp(input.userId, xpAmount);
  }

  if (coinsAwarded) {
    await prisma.user.update({
      where: { id: input.userId },
      data: { coinsBalance: { increment: coinAmount } },
    });
  }

  if (countsForStreak && (xpAwarded || coinsAwarded || (xpAmount === 0 && coinAmount === 0))) {
    await markMeaningfulStreakActivity(input.userId);
  }

  return {
    xpAwarded,
    coinsAwarded,
    xpAmount: xpAwarded ? xpAmount : 0,
    coinAmount: coinsAwarded ? coinAmount : 0,
  };
}

export async function awardActivityProgress(input: {
  userId: string;
  activityType: string;
  count?: number;
  sourceId?: string | null;
}) {
  const count = Math.max(0, Math.floor(input.count || 0));
  if (count <= 0 || !isMeaningfulActivity(input.activityType)) {
    return { xpAwarded: false, coinsAwarded: false, xpAmount: 0, coinAmount: 0 };
  }

  const baseAmount = ACTIVITY_XP_REWARD[input.activityType] || 0;
  if (baseAmount <= 0) {
    return { xpAwarded: false, coinsAwarded: false, xpAmount: 0, coinAmount: 0 };
  }

  let xpAmount = baseAmount * count;
  if (input.activityType === 'message') {
    const today = startOfUtcDay();
    const earnedToday = await prisma.xp_transactions.aggregate({
      where: {
        userId: input.userId,
        type: 'message_activity',
        currency: 'XP',
        createdAt: { gte: today },
      },
      _sum: { amount: true },
    });
    const remaining = Math.max(0, MESSAGE_DAILY_XP_CAP - (earnedToday._sum.amount || 0));
    xpAmount = Math.min(xpAmount, remaining);
  }

  if (xpAmount <= 0) {
    return { xpAwarded: false, coinsAwarded: false, xpAmount: 0, coinAmount: 0 };
  }

  return awardUserProgress({
    userId: input.userId,
    xpAmount,
    type: `${input.activityType}_activity`,
    source: input.activityType,
    sourceId: input.sourceId || undefined,
    description: `${input.activityType.replace(/_/g, ' ')} activity`,
    countsForStreak: true,
    idempotencyKey: input.sourceId
      ? `${input.userId}:${input.activityType}:${input.sourceId}`
      : undefined,
  });
}

export async function spendCoins(input: {
  userId: string;
  amount: number;
  type: string;
  source: string;
  sourceId?: string | null;
  description?: string;
}) {
  const amount = Math.max(0, Math.floor(input.amount || 0));
  if (amount <= 0) {
    throw new Error('Coin amount must be greater than zero');
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { coinsBalance: true, xpBalance: true },
  });

  const storedCoinsBalance = user?.coinsBalance || 0;
  const currentBalance = storedCoinsBalance || user?.xpBalance || 0;
  if (!user || currentBalance < amount) {
    throw new Error('Not enough Coins');
  }

  const newBalance = currentBalance - amount;
  const coinBalanceUpdate =
    storedCoinsBalance > 0 || !user.xpBalance
      ? { decrement: amount }
      : { set: newBalance };

  await prisma.$transaction([
    prisma.user.update({
      where: { id: input.userId },
      data: {
        coinsBalance: coinBalanceUpdate,
      },
    }),
    prisma.xp_transactions.create({
      data: {
        userId: input.userId,
        amount: -amount,
        type: input.type,
        source: input.source,
        sourceId: input.sourceId || undefined,
        description: input.description,
        currency: 'COINS',
        countsForStreak: false,
      },
    }),
  ]);

  return { newBalance };
}

export async function calculateDailyActivityStreak(userId: string) {
  const activities = await prisma.userDailyActivity.findMany({
    where: { userId },
    orderBy: { date: 'desc' },
  });

  const activeDays = activities.filter((activity) => activity.isActive);
  const totalActiveDays = activeDays.length;
  const lastActiveDate = activeDays[0]?.date || null;
  const today = startOfUtcDay();
  let checkDate = new Date(today);
  let current = 0;

  if (!sameUtcDay(lastActiveDate, today)) {
    checkDate.setUTCDate(checkDate.getUTCDate() - 1);
  }

  while (true) {
    const dateKey = checkDate.toISOString().split('T')[0];
    const activity = activities.find(
      (item) => item.isActive && item.date.toISOString().split('T')[0] === dateKey
    );

    if (!activity) break;
    current += 1;
    checkDate.setUTCDate(checkDate.getUTCDate() - 1);
  }

  let longest = 0;
  let running = 0;
  const sorted = [...activities].sort((left, right) => left.date.getTime() - right.date.getTime());
  for (const activity of sorted) {
    if (activity.isActive) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  return {
    current,
    longest,
    totalActiveDays,
    lastQualifiedDate: lastActiveDate,
    qualifiedToday: sameUtcDay(lastActiveDate, today),
    isAtRisk: current > 0 && !sameUtcDay(lastActiveDate, today),
  };
}

export async function getProgressOverview(userId: string) {
  const [user, lifetimeXp, streak, engagementStreak, coinTransactions] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coinsBalance: true, xpBalance: true },
    }),
    getLifetimeXp(userId),
    calculateDailyActivityStreak(userId),
    prisma.engagement_streaks.findUnique({ where: { userId } }),
    prisma.xp_transactions.findMany({
      where: {
        userId,
        currency: 'COINS',
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const xp = calculateLevelProgress(lifetimeXp);
  const coinsBalance = user?.coinsBalance || user?.xpBalance || 0;

  return {
    xp: {
      ...xp,
      rules: XP_EARNING_RULES,
    },
    coins: {
      balance: coinsBalance,
      rules: COIN_RULES,
      recentTransactions: coinTransactions.map((transaction) => ({
        id: transaction.id,
        amount: transaction.amount,
        type: transaction.type,
        source: transaction.source,
        sourceId: transaction.sourceId,
        description: transaction.description,
        createdAt: transaction.createdAt.toISOString(),
      })),
    },
    streak: {
      current: streak.current,
      longest: streak.longest,
      qualifiedToday: streak.qualifiedToday,
      isAtRisk: streak.isAtRisk,
      lastQualifiedDate: streak.lastQualifiedDate?.toISOString().split('T')[0] || null,
      totalActiveDays: streak.totalActiveDays,
      rules: STREAK_RULES,
      categories: {
        login: {
          current: engagementStreak?.loginStreak || 0,
          longest: engagementStreak?.longestLoginStreak || engagementStreak?.bestLoginStreak || 0,
          lastDate: engagementStreak?.lastLoginDate?.toISOString().split('T')[0] || null,
        },
        networking: {
          current: engagementStreak?.connectionStreak || 0,
          longest: engagementStreak?.longestConnectionStreak || engagementStreak?.bestConnectionStreak || 0,
          lastDate: engagementStreak?.lastConnectionDate?.toISOString().split('T')[0] || null,
        },
        posting: {
          current: engagementStreak?.postingStreak || 0,
          longest: engagementStreak?.longestPostingStreak || engagementStreak?.bestPostingStreak || 0,
          lastDate: engagementStreak?.lastPostDate?.toISOString().split('T')[0] || null,
        },
        messaging: {
          current: engagementStreak?.messagingStreak || 0,
          longest: engagementStreak?.longestMessagingStreak || engagementStreak?.bestMessagingStreak || 0,
          lastDate: engagementStreak?.lastMessageDate?.toISOString().split('T')[0] || null,
        },
      },
    },
  };
}
