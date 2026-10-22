import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getDiscoveryAccess, hasPremiumPeopleDiscoveryFilters, buildPremiumRequiredDiscoveryResponse, buildPeopleDiscoveryWhere } from "../../services/discovery-power.service";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { prismaRead } from "../../../../config/prisma";
import { getPremiumVisibilityByUserIds, sortByPremiumVisibility } from "../../../premium/services/premium-visibility.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { PeopleResponse, decodePeopleCursor, parseBoundedInt, PEOPLE_BROWSE_DEFAULT_LIMIT, PEOPLE_MAX_LIMIT, buildCursorWhere, buildPeopleListCacheKey, normalizeSearchText, shouldBypassPeopleCache, PEOPLE_MIN_TEXT_SEARCH_LENGTH, peopleOrderBy, personCardUserSelectWithCursor, getRelationshipSummary, PersonCard, mapUserToPersonCard, encodePeopleCursor, peopleCacheTags, PEOPLE_AUTH_CACHE_TTL_SECONDS, PEOPLE_PUBLIC_CACHE_TTL_SECONDS, filterBlockedPeople, recordPeopleSearchAppearancesIfNeeded } from "./support.controller";

/**
 * Get people with filters and pagination
 * GET /api/people
 */
export const getPeople = async (
  req: AuthenticatedRequest,
  res: Response<PeopleResponse | ErrorResponse>
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const access = await getDiscoveryAccess(userId);

    if (hasPremiumPeopleDiscoveryFilters(req.query) && !access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Premium discovery filters'));
      return;
    }

    const cursor = decodePeopleCursor(req.query.cursor);
    const requestedPage = parseBoundedInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const page = cursor ? 1 : requestedPage;
    const limit = parseBoundedInt(req.query.limit, PEOPLE_BROWSE_DEFAULT_LIMIT, 1, PEOPLE_MAX_LIMIT);
    const includeMutualConnections = req.query.includeMutuals !== 'false' && req.query.includeMutualConnections !== 'false';
    const cursorWhere = buildCursorWhere(cursor);
    const cacheKey = buildPeopleListCacheKey(userId, req.query);
    const rawSearch = normalizeSearchText(req.query.search);
    const hasSearchParam = typeof req.query.search === 'string' && req.query.search.trim().length > 0;
    const bypassCache = shouldBypassPeopleCache(req);
    const blockedUserIds = userId ? await getBlockedUserIds(userId) : [];

    if (hasSearchParam && rawSearch.length < PEOPLE_MIN_TEXT_SEARCH_LENGTH) {
      res.status(200).json({
        people: [],
        total: 0,
        page,
        totalPages: 1,
        hasMore: false,
        nextCursor: null,
      });
      return;
    }

    const computeResponse = async (): Promise<PeopleResponse> => {
      const { where } = await buildPeopleDiscoveryWhere({
        userId,
        query: req.query,
        access,
        applyDefaultLocalScope: false,
      });

      const blockedWhere = blockedUserIds.length > 0 ? { id: { notIn: blockedUserIds } } : null;
      const countWhere = blockedWhere ? { AND: [where, blockedWhere] } : where;
      const findWhere = cursorWhere
        ? { AND: [where, cursorWhere, ...(blockedWhere ? [blockedWhere] : [])] }
        : countWhere;
      const fetchedUsers = await prismaRead.user.findMany({
        where: findWhere,
        take: limit + 1,
        orderBy: peopleOrderBy,
        select: personCardUserSelectWithCursor,
      });

      // The cursor must be calculated from the database-ordered page boundary.
      // Premium visibility may only rearrange the users inside that boundary;
      // otherwise a boosted user can move across the cursor and create gaps.
      const databaseOrderedPage = fetchedUsers.slice(0, limit);
      const visibilityByUser = await getPremiumVisibilityByUserIds(
        databaseOrderedPage.map((user) => user.id)
      );
      const users = sortByPremiumVisibility(databaseOrderedPage, visibilityByUser);
      const hasExtraUser = fetchedUsers.length > limit;
      const relationship = await getRelationshipSummary(
        userId,
        users.map((user) => user.id),
        includeMutualConnections
      );
      const people: PersonCard[] = users.map((user) =>
        mapUserToPersonCard(user, relationship, visibilityByUser)
      );

      const total = people.length + (hasExtraUser ? 1 : 0);
      const totalPages = hasExtraUser ? page + 1 : page;
      const hasMore = hasExtraUser;
      return {
        people,
        total,
        page,
        totalPages,
        hasMore,
        nextCursor: hasMore && databaseOrderedPage.length > 0
          ? encodePeopleCursor(databaseOrderedPage[databaseOrderedPage.length - 1])
          : null,
        totalIsApproximate: true,
      };
    };

    const response = !bypassCache && cacheKey
      ? await cacheService.getOrSet(cacheKey, computeResponse, {
          tags: peopleCacheTags(userId),
          swr: {
            softTtlSeconds: userId ? PEOPLE_AUTH_CACHE_TTL_SECONDS : PEOPLE_PUBLIC_CACHE_TTL_SECONDS,
            hardTtlSeconds: (userId ? PEOPLE_AUTH_CACHE_TTL_SECONDS : PEOPLE_PUBLIC_CACHE_TTL_SECONDS) * 4,
          },
        })
      : await computeResponse();

    const filteredPeople = filterBlockedPeople(response.people, blockedUserIds);
    const filteredResponse = filteredPeople.length === response.people.length
      ? response
      : { ...response, people: filteredPeople };

    void recordPeopleSearchAppearancesIfNeeded(userId, req.query, filteredPeople);

    res.setHeader('X-Vormex-Cache', bypassCache ? 'BYPASS' : 'MISS');
    res.status(200).json(filteredResponse);
  } catch (error) {
    console.error('Error fetching people:', error);
    res.status(500).json({
      error: 'Failed to fetch people',
    });
  }
};
