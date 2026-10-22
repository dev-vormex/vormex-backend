import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prismaRead } from "../../../../config/prisma";
import { getPremiumVisibilityByUserIds, sortByPremiumVisibility } from "../../../premium/services/premium-visibility.service";
import { PersonCard, parseBoundedInt, PEOPLE_PERSONALIZED_MAX_LIMIT, peopleNearMeCacheKey, filterBlockedPeople, PEOPLE_NEAR_ME_CACHE_TTL_SECONDS, peopleCacheTags, normalizeSearchText, peopleOrderBy, personCardUserSelect, getRelationshipSummary, mapUserToPersonCard, FilterOptions, PEOPLE_FILTER_OPTIONS_CACHE_KEY, PEOPLE_FILTER_OPTION_LIMIT, PEOPLE_FILTER_OPTIONS_CACHE_TTL_SECONDS } from "./support.controller";

/**
 * Get people near the user
 * GET /api/people/near-me
 */
export const getPeopleNearMe = async (
  req: AuthenticatedRequest,
  res: Response<{ people: PersonCard[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);
    const cacheKey = peopleNearMeCacheKey(userId, limit);
    const blockedUserIds = await getBlockedUserIds(userId);
    const cached = await cacheService.get<{ people: PersonCard[] }>(cacheKey);
    if (cached) {
      const filteredPeople = filterBlockedPeople(cached.people, blockedUserIds);
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json({ ...cached, people: filteredPeople });
      return;
    }

    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { location: true, currentCity: true },
    });

    if (!currentUser || (!currentUser.location && !currentUser.currentCity)) {
      const response = { people: [] };
      await cacheService.set(
        cacheKey,
        response,
        PEOPLE_NEAR_ME_CACHE_TTL_SECONDS,
        peopleCacheTags(userId)
      );
      res.setHeader('X-Vormex-Cache', 'MISS');
      res.status(200).json(response);
      return;
    }

    const locationSearch = normalizeSearchText(currentUser.currentCity || currentUser.location, 120);

    const users = await prismaRead.user.findMany({
      where: {
        id: { notIn: [userId, ...blockedUserIds] },
        isBanned: false,
        shareLocationPublic: true,
        OR: [
          { location: { contains: locationSearch || '', mode: 'insensitive' } },
          { currentCity: { contains: locationSearch || '', mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: peopleOrderBy,
      select: personCardUserSelect,
    });

    const visibilityByUser = await getPremiumVisibilityByUserIds(users.map((user) => user.id));
    const sortedUsers = sortByPremiumVisibility(users, visibilityByUser);
    const relationship = await getRelationshipSummary(userId, sortedUsers.map((user) => user.id));
    const people: PersonCard[] = sortedUsers.map((user) =>
      mapUserToPersonCard(user, relationship, visibilityByUser)
    );

    const response = { people };
    await cacheService.set(
      cacheKey,
      response,
      PEOPLE_NEAR_ME_CACHE_TTL_SECONDS,
      peopleCacheTags(userId)
    );

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching people near me:', error);
    res.status(500).json({ error: 'Failed to fetch nearby people' });
  }
};

/**
 * Get filter options
 * GET /api/people/filter-options
 */
export const getFilterOptions = async (
  _req: AuthenticatedRequest,
  res: Response<FilterOptions | ErrorResponse>
): Promise<void> => {
  try {
    const cached = await cacheService.get<FilterOptions>(PEOPLE_FILTER_OPTIONS_CACHE_KEY);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }

    const [collegesResult, branchesResult, yearsResult, locationsResult] = await Promise.all([
      prismaRead.user.groupBy({
        by: ['college'],
        where: { isBanned: false, college: { not: null } },
        _count: { college: true },
        orderBy: { _count: { college: 'desc' } },
        take: PEOPLE_FILTER_OPTION_LIMIT,
      }),
      prismaRead.user.groupBy({
        by: ['branch'],
        where: { isBanned: false, branch: { not: null } },
        _count: { branch: true },
        orderBy: { _count: { branch: 'desc' } },
        take: PEOPLE_FILTER_OPTION_LIMIT,
      }),
      prismaRead.user.groupBy({
        by: ['graduationYear'],
        where: { isBanned: false, graduationYear: { not: null } },
        orderBy: { graduationYear: 'desc' },
        take: PEOPLE_FILTER_OPTION_LIMIT,
      }),
      prismaRead.user.groupBy({
        by: ['currentCity'],
        where: { isBanned: false, shareLocationPublic: true, currentCity: { not: null } },
        _count: { currentCity: true },
        orderBy: { _count: { currentCity: 'desc' } },
        take: PEOPLE_FILTER_OPTION_LIMIT,
      }),
    ]);

    const response = {
      colleges: collegesResult.map((c) => c.college!).filter(Boolean).sort(),
      branches: branchesResult.map((b) => b.branch!).filter(Boolean).sort(),
      graduationYears: yearsResult.map((y) => y.graduationYear!).filter(Boolean),
      locations: locationsResult.map((l) => l.currentCity!).filter(Boolean).sort(),
    };

    await cacheService.set(
      PEOPLE_FILTER_OPTIONS_CACHE_KEY,
      response,
      PEOPLE_FILTER_OPTIONS_CACHE_TTL_SECONDS,
      ['people:filters']
    );

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching filter options:', error);
    res.status(500).json({ error: 'Failed to fetch filter options' });
  }
};
