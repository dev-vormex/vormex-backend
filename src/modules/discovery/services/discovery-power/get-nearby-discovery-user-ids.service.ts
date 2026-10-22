import { Prisma } from "@prisma/client";
import { prismaRead } from "../../../../config/prisma";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { searchVariants, normalizeIntentValues, QueryLike, normalizeBoolean, normalizeSearchText, DiscoveryAccess, PEOPLE_MIN_TEXT_SEARCH_LENGTH, splitQueryList, mergeUserOnboarding, parseNumber } from "./free-discovery-suggestions-per-day.service";

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
  const clauses: Prisma.UserWhereInput[] = [
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
  const blockedUserIds = await getBlockedUserIds(params.userId);
  const blockedClause = blockedUserIds.length > 0
    ? Prisma.sql`AND "id" NOT IN (${Prisma.join(blockedUserIds)})`
    : Prisma.empty;
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
        AND ("safetySuspendedUntil" IS NULL OR "safetySuspendedUntil" <= CURRENT_TIMESTAMP)
        ${blockedClause}
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
    const blockedUserIds = await getBlockedUserIds(userId);
    andClauses.push({ id: { notIn: [userId, ...blockedUserIds] } });
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
