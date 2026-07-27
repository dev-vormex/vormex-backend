// @ts-nocheck
import { Prisma } from '@prisma/client';
import { prisma, prismaRead } from '../config/prisma';
import { cacheService } from './cache.service';
import { getPremiumAccessSnapshot } from './premium-access.service';
import { getDailyUsageWindowStart } from './tier-limits.service';
import { notificationService } from './notification.service';
import { pushNotificationService } from './push-notification.service';

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

const SAVED_SEARCH_FILTER_KEYS = new Set([
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

const PEOPLE_MIN_TEXT_SEARCH_LENGTH = 2;
const PEOPLE_MAX_FILTER_VALUES = 10;
const SAVED_SEARCH_MATCH_SCAN_LIMIT = 80;

type QueryLike = Record<string, unknown>;

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

const normalizeSearchText = (value: unknown, maxLength = 100): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

const normalizeBoolean = (value: unknown): boolean =>
  value === true || value === 'true' || value === '1';

const parseNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const splitQueryList = (value: unknown): string[] => {
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

const mergeUserOnboarding = (andClauses: any[], isClause: Record<string, unknown>) => {
  andClauses.push({ user_onboarding: { is: isClause } });
};

async function findCaseInsensitiveArraySearchUserIds(search: string): Promise<string[]> {
  const pattern = `%${search.toLowerCase()}%`;
  const rows = await prismaRead.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT DISTINCT "id"
    FROM (
      SELECT u."id"
      FROM "users" u
      WHERE EXISTS (
        SELECT 1
        FROM unnest(u."interests") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )

      UNION

      SELECT uo."userId" AS "id"
      FROM "user_onboarding" uo
      WHERE EXISTS (
        SELECT 1
        FROM unnest(uo."secondaryGoals") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )
      OR EXISTS (
        SELECT 1
        FROM unnest(uo."wantToLearn") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )
      OR EXISTS (
        SELECT 1
        FROM unnest(uo."canTeach") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )
      OR EXISTS (
        SELECT 1
        FROM unnest(uo."lookingFor") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )

      UNION

      SELECT op."userId" AS "id"
      FROM "onboarding_profiles" op
      WHERE EXISTS (
        SELECT 1
        FROM unnest(op."skillsToLearn") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )
      OR EXISTS (
        SELECT 1
        FROM unnest(op."skillsToTeach") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )
      OR EXISTS (
        SELECT 1
        FROM unnest(op."lookingFor") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )

      UNION

      SELECT p."userId" AS "id"
      FROM "projects" p
      WHERE EXISTS (
        SELECT 1
        FROM unnest(p."techStack") AS item(value)
        WHERE LOWER(item.value) LIKE ${pattern}
      )
    ) matches
    LIMIT 5000
  `);

  return rows.map((row) => row.id).filter(Boolean);
}

const buildSearchOr = (normalizedSearch: string, caseInsensitiveArrayUserIds: string[] = []): any[] => {
  const variants = searchVariants(normalizedSearch);
  const clauses = [
    { name: { contains: normalizedSearch, mode: 'insensitive' } },
    { username: { contains: normalizedSearch, mode: 'insensitive' } },
    { headline: { contains: normalizedSearch, mode: 'insensitive' } },
    { bio: { contains: normalizedSearch, mode: 'insensitive' } },
    { college: { contains: normalizedSearch, mode: 'insensitive' } },
    { branch: { contains: normalizedSearch, mode: 'insensitive' } },
    { location: { contains: normalizedSearch, mode: 'insensitive' } },
    { currentCity: { contains: normalizedSearch, mode: 'insensitive' } },
    { currentState: { contains: normalizedSearch, mode: 'insensitive' } },
    { currentCountry: { contains: normalizedSearch, mode: 'insensitive' } },
    {
      skills: {
        some: {
          skill: {
            name: { contains: normalizedSearch, mode: 'insensitive' },
          },
        },
      },
    },
    { interests: { hasSome: variants } },
    {
      user_onboarding: {
        is: {
          OR: [
            { primaryGoal: { contains: normalizedSearch, mode: 'insensitive' } },
            { availability: { contains: normalizedSearch, mode: 'insensitive' } },
            { secondaryGoals: { hasSome: variants } },
            { wantToLearn: { hasSome: variants } },
            { canTeach: { hasSome: variants } },
            { lookingFor: { hasSome: normalizeIntentValues(normalizedSearch) } },
          ],
        },
      },
    },
    {
      onboarding_profiles: {
        is: {
          OR: [
            { primaryGoal: { contains: normalizedSearch, mode: 'insensitive' } },
            { skillLevel: { contains: normalizedSearch, mode: 'insensitive' } },
            { dailySchedule: { contains: normalizedSearch, mode: 'insensitive' } },
            { campus: { contains: normalizedSearch, mode: 'insensitive' } },
            { skillsToLearn: { hasSome: variants } },
            { skillsToTeach: { hasSome: variants } },
            { lookingFor: { hasSome: normalizeIntentValues(normalizedSearch) } },
          ],
        },
      },
    },
    {
      projects: {
        some: {
          OR: [
            { name: { contains: normalizedSearch, mode: 'insensitive' } },
            { description: { contains: normalizedSearch, mode: 'insensitive' } },
            { role: { contains: normalizedSearch, mode: 'insensitive' } },
            { techStack: { hasSome: variants } },
          ],
        },
      },
    },
  ];

  if (caseInsensitiveArrayUserIds.length > 0) {
    clauses.push({ id: { in: caseInsensitiveArrayUserIds } });
  }

  return clauses;
};

function localDiscoveryOr(currentUser: any): any[] {
  const clauses: any[] = [];
  if (currentUser?.college) clauses.push({ college: currentUser.college });
  if (currentUser?.branch) clauses.push({ branch: currentUser.branch });
  if (currentUser?.currentCity) clauses.push({ currentCity: currentUser.currentCity });
  if (currentUser?.location) clauses.push({ location: { contains: currentUser.location, mode: 'insensitive' } });
  if (currentUser?.currentCountry) clauses.push({ currentCountry: currentUser.currentCountry });
  return clauses;
}

function hasSpecificDiscoveryFilter(query: QueryLike): boolean {
  return [
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
  ].some((key) => {
    const value = query[key];
    if (key === 'verifiedOnly' || key === 'isOpenToOpportunities') return normalizeBoolean(value);
    return normalizeSearchText(value, 120) !== '';
  });
}

export async function getNearbyDiscoveryUserIds(params: {
  userId: string;
  lat: number;
  lng: number;
  radiusKm: number;
  limit?: number;
}): Promise<string[]> {
  const radiusKm = Math.min(500, Math.max(1, Math.floor(params.radiusKm)));
  const lat = params.lat;
  const lng = params.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.01, Math.abs(Math.cos((lat * Math.PI) / 180))));
  const rows = await prismaRead.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM (
      SELECT
        "id",
        "lastActiveAt",
        6371 * 2 * ASIN(LEAST(1, SQRT(
          POWER(SIN(RADIANS(("latitude" - ${lat}) / 2)), 2) +
          COS(RADIANS(${lat})) * COS(RADIANS("latitude")) *
          POWER(SIN(RADIANS(("longitude" - ${lng}) / 2)), 2)
        ))) AS "distance"
      FROM "users"
      WHERE "id" <> ${params.userId}
        AND "isBanned" = false
        AND "latitude" IS NOT NULL
        AND "longitude" IS NOT NULL
        AND "latitude" BETWEEN ${lat - latDelta} AND ${lat + latDelta}
        AND "longitude" BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
        AND COALESCE("locationPermission", true) = true
        AND "shareLocationPublic" = true
    ) ranked
    WHERE "distance" <= ${radiusKm}
    ORDER BY "distance" ASC, "lastActiveAt" DESC NULLS LAST, "id" ASC
    LIMIT ${Math.min(Math.max(params.limit || 500, 1), 1000)}
  `);

  return rows.map((row) => row.id);
}

export async function buildPeopleDiscoveryWhere(params: {
  userId: string | null;
  query: QueryLike;
  access?: DiscoveryAccess;
  applyDefaultLocalScope?: boolean;
}): Promise<{ where: any; currentUser: any | null; radiusUserIds: string[] | null }> {
  const { userId, query } = params;
  const andClauses: any[] = [{ isBanned: false }];

  if (userId) {
    andClauses.push({ id: { not: userId } });
  }

  const currentUser = userId
    ? await prismaRead.user.findUnique({
        where: { id: userId },
        select: {
          college: true,
          branch: true,
          location: true,
          currentCity: true,
          currentState: true,
          currentCountry: true,
        },
      })
    : null;

  const rawSearch = normalizeSearchText(query.search);
  const normalizedSearch = rawSearch.length >= PEOPLE_MIN_TEXT_SEARCH_LENGTH ? rawSearch : '';
  if (normalizedSearch) {
    const caseInsensitiveArrayUserIds = await findCaseInsensitiveArraySearchUserIds(normalizedSearch);
    andClauses.push({ OR: buildSearchOr(normalizedSearch, caseInsensitiveArrayUserIds) });
  }

  const normalizedCollege = normalizeSearchText(query.college, 120);
  if (normalizedCollege) andClauses.push({ college: normalizedCollege });

  const normalizedBranch = normalizeSearchText(query.branch, 120);
  if (normalizedBranch) andClauses.push({ branch: normalizedBranch });

  const graduationYear = parseInt(String(query.graduationYear ?? ''), 10);
  if (Number.isFinite(graduationYear)) andClauses.push({ graduationYear });

  const skillList = splitQueryList(query.skills);
  if (skillList.length > 0) {
    andClauses.push({
      skills: {
        some: {
          skill: {
            name: { in: skillList, mode: 'insensitive' },
          },
        },
      },
    });
  }

  const interestList = splitQueryList(query.interests);
  if (interestList.length > 0) {
    andClauses.push({ interests: { hasSome: interestList.flatMap(searchVariants) } });
  }

  const normalizedLocation = normalizeSearchText(query.location, 120);
  if (normalizedLocation) {
    andClauses.push({
      OR: [
        { location: { contains: normalizedLocation, mode: 'insensitive' } },
        { currentCity: { contains: normalizedLocation, mode: 'insensitive' } },
        { currentState: { contains: normalizedLocation, mode: 'insensitive' } },
        { currentCountry: { contains: normalizedLocation, mode: 'insensitive' } },
      ],
    });
  }

  if (normalizeBoolean(query.isOpenToOpportunities)) {
    andClauses.push({ isOpenToOpportunities: true });
  }

  const skillLevel = normalizeSearchText(query.skillLevel, 80);
  if (skillLevel) {
    andClauses.push({
      onboarding_profiles: {
        is: {
          skillLevel: { contains: skillLevel, mode: 'insensitive' },
        },
      },
    });
  }

  const intents = normalizeIntentValues(query.intent);
  if (intents.length > 0) {
    mergeUserOnboarding(andClauses, { lookingFor: { hasSome: intents } });
  }

  const availability = normalizeSearchText(query.availability, 80);
  if (availability) {
    mergeUserOnboarding(andClauses, { availability: { contains: availability, mode: 'insensitive' } });
  }

  if (normalizeBoolean(query.verifiedOnly)) {
    andClauses.push({ isVerified: true });
  }

  let radiusUserIds: string[] | null = null;
  const radiusKm = parseNumber(query.radiusKm);
  const lat = parseNumber(query.lat);
  const lng = parseNumber(query.lng);
  if (userId && radiusKm && lat !== null && lng !== null) {
    radiusUserIds = await getNearbyDiscoveryUserIds({ userId, lat, lng, radiusKm });
    andClauses.push({ id: { in: radiusUserIds } });
  }

  const scope = normalizeSearchText(query.scope, 20).toLowerCase();
  const shouldApplyLocalScope =
    currentUser &&
    scope !== 'global' &&
    (scope === 'local' || (params.applyDefaultLocalScope && !hasSpecificDiscoveryFilter(query)));
  if (shouldApplyLocalScope) {
    const localOr = localDiscoveryOr(currentUser);
    if (localOr.length > 0) {
      andClauses.push({ OR: localOr });
    }
  }

  return {
    where: andClauses.length === 1 ? andClauses[0] : { AND: andClauses },
    currentUser,
    radiusUserIds,
  };
}

export function sanitizeSavedSearchFilters(input: unknown): Record<string, unknown> {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const filters: Record<string, unknown> = {};

  for (const key of SAVED_SEARCH_FILTER_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;

    if (key === 'verifiedOnly' || key === 'isOpenToOpportunities') {
      if (normalizeBoolean(value)) filters[key] = true;
      continue;
    }

    if (key === 'graduationYear' || key === 'radiusKm') {
      const number = parseNumber(value);
      if (number !== null) filters[key] = Math.floor(number);
      continue;
    }

    if (key === 'lat' || key === 'lng') {
      const number = parseNumber(value);
      if (number !== null) filters[key] = number;
      continue;
    }

    const text = normalizeSearchText(value, key === 'search' ? 100 : 160);
    if (text) filters[key] = text;
  }

  return filters;
}

function mapSavedDiscoverySearch(search: any, unseenCount?: number) {
  return {
    id: search.id,
    name: search.name,
    filters: sanitizeSavedSearchFilters(search.filters || {}),
    notificationsEnabled: Boolean(search.notificationsEnabled),
    digestEnabled: Boolean(search.digestEnabled),
    unseenCount: unseenCount ?? search._count?.matches ?? 0,
    lastViewedAt: search.lastViewedAt?.toISOString?.() ?? null,
    lastScannedAt: search.lastScannedAt?.toISOString?.() ?? null,
    lastDigestSentAt: search.lastDigestSentAt?.toISOString?.() ?? null,
    createdAt: search.createdAt?.toISOString?.() ?? null,
    updatedAt: search.updatedAt?.toISOString?.() ?? null,
  };
}

async function findSavedSearchMatchIds(search: any): Promise<string[]> {
  const filters = sanitizeSavedSearchFilters(search.filters || {});
  const { where } = await buildPeopleDiscoveryWhere({
    userId: search.userId,
    query: filters,
    access: { isPremium: true, isAdmin: false },
    applyDefaultLocalScope: filters.scope !== 'global',
  });

  const users = await prismaRead.user.findMany({
    where,
    select: { id: true },
    orderBy: [
      { lastActiveAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ],
    take: SAVED_SEARCH_MATCH_SCAN_LIMIT,
  });

  return users.map((user) => user.id);
}

async function refreshSavedSearchMatches(search: any, options: { seedAsSeen?: boolean } = {}) {
  const targetUserIds = await findSavedSearchMatchIds(search);
  const now = new Date();
  if (targetUserIds.length > 0) {
    await prisma.saved_discovery_search_matches.createMany({
      data: targetUserIds.map((targetUserId) => ({
        savedSearchId: search.id,
        targetUserId,
        seenAt: options.seedAsSeen ? now : null,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.saved_discovery_searches.update({
    where: { id: search.id },
    data: { lastScannedAt: now },
  });

  return targetUserIds.length;
}

export async function listSavedDiscoverySearches(userId: string) {
  const searches = await prismaRead.saved_discovery_searches.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 25,
  });

  await Promise.all(searches.map((search) => refreshSavedSearchMatches(search).catch(() => 0)));

  const refreshed = await prismaRead.saved_discovery_searches.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 25,
    include: {
      _count: {
        select: {
          matches: { where: { seenAt: null } },
        },
      },
    },
  });

  return refreshed.map((search) => mapSavedDiscoverySearch(search));
}

export async function createSavedDiscoverySearch(userId: string, body: any) {
  const filters = sanitizeSavedSearchFilters(body?.filters || body || {});
  const requestedName = normalizeSearchText(body?.name, 80);
  const name = requestedName || normalizeSearchText(filters.search, 40) || 'Discovery search';

  const search = await prisma.saved_discovery_searches.create({
    data: {
      userId,
      name,
      filters,
      notificationsEnabled: body?.notificationsEnabled !== false,
      digestEnabled: body?.digestEnabled !== false,
    },
  });

  await refreshSavedSearchMatches(search, { seedAsSeen: true });

  const refreshed = await prismaRead.saved_discovery_searches.findUnique({
    where: { id: search.id },
    include: {
      _count: {
        select: {
          matches: { where: { seenAt: null } },
        },
      },
    },
  });

  return mapSavedDiscoverySearch(refreshed || search);
}

export async function updateSavedDiscoverySearch(userId: string, searchId: string, body: any) {
  const existing = await prismaRead.saved_discovery_searches.findFirst({
    where: { id: searchId, userId },
  });
  if (!existing) return null;

  if (body?.markViewed === true) {
    const now = new Date();
    await prisma.$transaction([
      prisma.saved_discovery_search_matches.updateMany({
        where: { savedSearchId: searchId, seenAt: null },
        data: { seenAt: now },
      }),
      prisma.saved_discovery_searches.update({
        where: { id: searchId },
        data: { lastViewedAt: now },
      }),
    ]);
  }

  const data: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = normalizeSearchText(body.name, 80);
    if (name) data.name = name;
  }
  if (body?.filters !== undefined) {
    data.filters = sanitizeSavedSearchFilters(body.filters);
  }
  if (body?.notificationsEnabled !== undefined) {
    data.notificationsEnabled = Boolean(body.notificationsEnabled);
  }
  if (body?.digestEnabled !== undefined) {
    data.digestEnabled = Boolean(body.digestEnabled);
  }

  const updated = Object.keys(data).length > 0
    ? await prisma.saved_discovery_searches.update({ where: { id: searchId }, data })
    : await prismaRead.saved_discovery_searches.findUnique({ where: { id: searchId } });

  if (body?.filters !== undefined) {
    await prisma.saved_discovery_search_matches.deleteMany({ where: { savedSearchId: searchId } });
    await refreshSavedSearchMatches(updated, { seedAsSeen: true });
  }

  const refreshed = await prismaRead.saved_discovery_searches.findUnique({
    where: { id: searchId },
    include: {
      _count: {
        select: {
          matches: { where: { seenAt: null } },
        },
      },
    },
  });

  return mapSavedDiscoverySearch(refreshed || updated);
}

export async function deleteSavedDiscoverySearch(userId: string, searchId: string): Promise<boolean> {
  const result = await prisma.saved_discovery_searches.deleteMany({
    where: { id: searchId, userId },
  });
  return result.count > 0;
}

export function buildSavedSearchDigestCopy(searchName: string, count: number) {
  const safeName = normalizeSearchText(searchName, 60) || 'your saved search';
  return {
    title: count === 1 ? 'New discovery match' : 'New discovery matches',
    body: count === 1
      ? `1 new person matches ${safeName}`
      : `${count} new people match ${safeName}`,
  };
}

export async function runSavedDiscoverySearchDigest(): Promise<{ processed: number; notified: number }> {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  const searches = await prismaRead.saved_discovery_searches.findMany({
    where: {
      notificationsEnabled: true,
      digestEnabled: true,
      OR: [
        { lastDigestSentAt: null },
        { lastDigestSentAt: { lt: recentCutoff } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 250,
  });

  let notified = 0;
  for (const search of searches) {
    await refreshSavedSearchMatches(search).catch(() => 0);

    const unseenMatches = await prismaRead.saved_discovery_search_matches.findMany({
      where: {
        savedSearchId: search.id,
        seenAt: null,
        digestSentAt: null,
      },
      select: { id: true, targetUserId: true },
      take: 10,
      orderBy: { firstMatchedAt: 'desc' },
    });

    if (unseenMatches.length === 0) continue;

    const copy = buildSavedSearchDigestCopy(search.name, unseenMatches.length);
    const matchedUserIds = unseenMatches.map((match) => match.targetUserId);
    await notificationService.createNotification({
      userId: search.userId,
      type: 'saved_search_digest',
      title: copy.title,
      body: copy.body,
      data: {
        screen: 'find_people',
        route: 'find_people',
        savedSearchId: search.id,
        savedSearchName: search.name,
        matchedUserIds,
        filters: sanitizeSavedSearchFilters(search.filters || {}),
      },
    });

    await pushNotificationService.sendToUser(search.userId, {
      title: copy.title,
      body: copy.body,
      data: {
        type: 'saved_search_digest',
        screen: 'find_people',
        savedSearchId: search.id,
      },
    }).catch(() => undefined);

    await prisma.$transaction([
      prisma.saved_discovery_search_matches.updateMany({
        where: { id: { in: unseenMatches.map((match) => match.id) } },
        data: {
          notifiedAt: now,
          digestSentAt: now,
        },
      }),
      prisma.saved_discovery_searches.update({
        where: { id: search.id },
        data: { lastDigestSentAt: now },
      }),
    ]);
    notified += 1;
  }

  return { processed: searches.length, notified };
}
