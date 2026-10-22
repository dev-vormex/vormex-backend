import { prisma, prismaRead } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { getPremiumAccessSnapshot } from "../../../premium/services/premium-access.service";
import { getDailyUsageWindowStart } from "../../../safety/services/tier-limits.service";

export const FREE_DISCOVERY_SUGGESTIONS_PER_DAY = 20;

export const DISCOVERY_SOURCE_FOR_YOU = 'for_you';

export const DISCOVERY_SOURCE_PEOPLE_SEARCH = 'people_search';

const PREMIUM_DISCOVERY_FILTER_KEYS = new Set([
  'skills',
  'interests',
  'location',
  'isOpenToOpportunities',
  'skillLevel',
  'intent',
  'availability',
  'verifiedOnly',
  'radiusKm',
  'lat',
  'lng',
]);

export const SAVED_SEARCH_FILTER_KEYS = new Set([
  'search',
  'college',
  'branch',
  'graduationYear',
  'skills',
  'interests',
  'location',
  'isOpenToOpportunities',
  'skillLevel',
  'intent',
  'availability',
  'verifiedOnly',
  'radiusKm',
  'lat',
  'lng',
  'scope',
]);

export const PEOPLE_MIN_TEXT_SEARCH_LENGTH = 2;

const PEOPLE_MAX_FILTER_VALUES = 10;

export const SAVED_SEARCH_MATCH_SCAN_LIMIT = 80;

export type QueryLike = Record<string, unknown>;

export type DiscoveryAccess = {
  isPremium: boolean;
  isAdmin: boolean;
};

export type SuggestionQuotaState = {
  allowed: boolean;
  isPremium: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  window: 'day';
  resetsAt: string | null;
  windowStart: Date;
};

export const normalizeSearchText = (value: unknown, maxLength = 100): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

export const normalizeBoolean = (value: unknown): boolean =>
  value === true || value === 'true' || value === '1';

export const parseNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const splitQueryList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeSearchText(String(item), 80))
      .filter(Boolean)
      .slice(0, PEOPLE_MAX_FILTER_VALUES);
  }

  if (typeof value !== 'string') return [];
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => normalizeSearchText(item, 80))
        .filter(Boolean)
        .slice(0, PEOPLE_MAX_FILTER_VALUES)
    )
  );
};

const titleCaseSearchValue = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

export const searchVariants = (value: string): string[] =>
  Array.from(
    new Set([value, value.toLowerCase(), value.toUpperCase(), titleCaseSearchValue(value)].filter(Boolean))
  );

export function normalizeIntentValues(value: unknown): string[] {
  const rawValues = splitQueryList(value);
  const values = rawValues.flatMap((item) => {
    const normalized = item.toLowerCase().replace(/[_\s]+/g, '-');
    if (normalized === 'cofounder' || normalized === 'co-founder') {
      return ['co-founder', 'cofounder', 'co founder', 'founder'];
    }
    if (normalized === 'collab' || normalized === 'collaborate' || normalized === 'collaboration') {
      return ['collab', 'collaborate', 'collaboration'];
    }
    return [item, normalized, titleCaseSearchValue(item)];
  });

  return Array.from(new Set(values.filter(Boolean))).slice(0, PEOPLE_MAX_FILTER_VALUES * 3);
}

export function hasPremiumPeopleDiscoveryFilters(query: QueryLike): boolean {
  for (const key of PREMIUM_DISCOVERY_FILTER_KEYS) {
    if (query[key] !== undefined && normalizeSearchText(query[key], 120) !== '') {
      if (key === 'verifiedOnly' || key === 'isOpenToOpportunities') {
        if (normalizeBoolean(query[key])) return true;
        continue;
      }
      return true;
    }
  }

  // Global discovery is the default directory experience for every account.
  // Premium continues to gate advanced filters (radius, verification, intent,
  // availability, and so on), but never the ability to browse the network.
  return false;
}

export function buildPremiumRequiredDiscoveryResponse(feature = 'Premium discovery') {
  return {
    error: 'Premium required',
    code: 'premium_required',
    feature,
    message: `${feature} is available for Premium accounts.`,
  };
}

export async function getDiscoveryAccess(userId: string | null): Promise<DiscoveryAccess> {
  if (!userId) {
    return { isPremium: false, isAdmin: false };
  }

  const snapshot = await getPremiumAccessSnapshot(userId);
  const isAdmin = Boolean(snapshot.user?.isAdmin);
  return {
    isPremium: Boolean(snapshot.isPremium || isAdmin),
    isAdmin,
  };
}

export async function getSuggestionQuotaState(userId: string): Promise<SuggestionQuotaState> {
  const access = await getDiscoveryAccess(userId);
  const windowStart = getDailyUsageWindowStart();
  const resetsAt = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);

  if (access.isPremium) {
    return {
      allowed: true,
      isPremium: true,
      limit: null,
      used: 0,
      remaining: null,
      window: 'day',
      resetsAt: null,
      windowStart,
    };
  }

  const used = await prismaRead.discovery_impressions.count({
    where: {
      userId,
      source: DISCOVERY_SOURCE_FOR_YOU,
      windowStart,
    },
  });

  return {
    allowed: used < FREE_DISCOVERY_SUGGESTIONS_PER_DAY,
    isPremium: false,
    limit: FREE_DISCOVERY_SUGGESTIONS_PER_DAY,
    used,
    remaining: Math.max(0, FREE_DISCOVERY_SUGGESTIONS_PER_DAY - used),
    window: 'day',
    resetsAt: resetsAt.toISOString(),
    windowStart,
  };
}

export async function recordSuggestionImpressions(
  userId: string,
  targetUserIds: string[],
  quota: SuggestionQuotaState
): Promise<SuggestionQuotaState> {
  const uniqueTargetIds = Array.from(new Set(targetUserIds.filter((id) => id && id !== userId)));
  if (quota.isPremium || uniqueTargetIds.length === 0) {
    return quota;
  }

  await prisma.discovery_impressions.createMany({
    data: uniqueTargetIds.map((targetUserId) => ({
      userId,
      targetUserId,
      source: DISCOVERY_SOURCE_FOR_YOU,
      windowStart: quota.windowStart,
    })),
    skipDuplicates: true,
  });

  return getSuggestionQuotaState(userId);
}

export async function recordPeopleSearchAppearances(
  userId: string,
  targetUserIds: string[]
): Promise<void> {
  const uniqueTargetIds = Array.from(new Set(targetUserIds.filter((id) => id && id !== userId)));
  if (!userId || uniqueTargetIds.length === 0) return;

  await prisma.discovery_impressions.createMany({
    data: uniqueTargetIds.map((targetUserId) => ({
      userId,
      targetUserId,
      source: DISCOVERY_SOURCE_PEOPLE_SEARCH,
      windowStart: getDailyUsageWindowStart(),
    })),
    skipDuplicates: true,
  });
}

export async function getActiveDiscoveryPassTargetIds(userId: string): Promise<string[]> {
  const passes = await prismaRead.discovery_passes.findMany({
    where: {
      userId,
      source: DISCOVERY_SOURCE_FOR_YOU,
      status: 'active',
    },
    select: { targetUserId: true },
    take: 1000,
  });

  return passes.map((pass) => pass.targetUserId);
}

export async function passDiscoveryUser(userId: string, targetUserId: string) {
  if (!targetUserId || targetUserId === userId) {
    throw new Error('Invalid target user');
  }

  const target = await prismaRead.user.findUnique({
    where: { id: targetUserId },
    select: { id: true },
  });
  if (!target) {
    throw new Error('User not found');
  }

  const now = new Date();
  const pass = await prisma.discovery_passes.upsert({
    where: {
      userId_targetUserId_source: {
        userId,
        targetUserId,
        source: DISCOVERY_SOURCE_FOR_YOU,
      },
    },
    update: {
      status: 'active',
      passedAt: now,
      rewoundAt: null,
    },
    create: {
      userId,
      targetUserId,
      source: DISCOVERY_SOURCE_FOR_YOU,
      status: 'active',
      passedAt: now,
    },
  });

  await invalidateDiscoveryPowerCaches(userId);
  return pass;
}

export async function rewindLastDiscoveryPass(userId: string) {
  const pass = await prismaRead.discovery_passes.findFirst({
    where: {
      userId,
      source: DISCOVERY_SOURCE_FOR_YOU,
      status: 'active',
    },
    orderBy: { passedAt: 'desc' },
  });

  if (!pass) return null;

  const rewound = await prisma.discovery_passes.update({
    where: { id: pass.id },
    data: {
      status: 'rewound',
      rewoundAt: new Date(),
    },
  });

  await invalidateDiscoveryPowerCaches(userId);
  return rewound;
}

export async function hasActiveDiscoveryPasses(userId: string): Promise<boolean> {
  const pass = await prismaRead.discovery_passes.findFirst({
    where: {
      userId,
      source: DISCOVERY_SOURCE_FOR_YOU,
      status: 'active',
    },
    select: { id: true },
  });
  return Boolean(pass);
}

async function invalidateDiscoveryPowerCaches(userId: string): Promise<void> {
  await cacheService
    .invalidateTags(`people:user:${userId}`, `matching:user:${userId}`, `people:connections:${userId}`)
    .catch(() => undefined);
}

export const mergeUserOnboarding = (andClauses: any[], isClause: Record<string, unknown>) => {
  andClauses.push({ user_onboarding: { is: isClause } });
};
