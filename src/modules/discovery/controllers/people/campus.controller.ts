import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prismaRead } from "../../../../config/prisma";
import { getPremiumVisibilityByUserIds, sortByPremiumVisibility } from "../../../premium/services/premium-visibility.service";
import { CollegeSuggestion, fetchGooglePlacesSchoolSuggestions, fetchCollegeDbSuggestions, fetchDirectoryCollegeSuggestions, searchCatalogColleges, mergeCollegeSuggestions, fetchCollegeLogoImage } from "../../../education/services/college-catalog.service";
import { PersonCard, parseBoundedInt, PEOPLE_PERSONALIZED_MAX_LIMIT, peopleSameCollegeCacheKey, filterBlockedPeople, PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS, peopleCacheTags, peopleOrderBy, personCardUserSelect, getRelationshipSummary, mapUserToPersonCard, normalizeSearchText, peopleCollegesCacheKey, withCollegeLogoProxyUrls, PEOPLE_COLLEGE_SEARCH_CACHE_TTL_SECONDS } from "./support.controller";

/**
 * Get people from same college
 * GET /api/people/same-college
 */
export const getPeopleFromSameCollege = async (
  req: AuthenticatedRequest,
  res: Response<{
    people: PersonCard[];
    userCollege?: string | null;
    total?: number;
    page?: number;
    totalPages?: number;
    hasMore?: boolean;
  } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const page = parseBoundedInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);
    const skip = (page - 1) * limit;
    const cacheKey = peopleSameCollegeCacheKey(userId, page, limit);
    const blockedUserIds = await getBlockedUserIds(userId);
    const cached = await cacheService.get<{
      people: PersonCard[];
      userCollege?: string | null;
      total?: number;
      page?: number;
      totalPages?: number;
      hasMore?: boolean;
    }>(cacheKey);
    if (cached) {
      const filteredPeople = filterBlockedPeople(cached.people, blockedUserIds);
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json({ ...cached, people: filteredPeople, total: filteredPeople.length });
      return;
    }

    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { college: true },
    });

    if (!currentUser || !currentUser.college) {
      const response = { people: [], userCollege: null };
      await cacheService.set(
        cacheKey,
        response,
        PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS,
        peopleCacheTags(userId)
      );
      res.setHeader('X-Vormex-Cache', 'MISS');
      res.status(200).json(response);
      return;
    }

    const users = await prismaRead.user.findMany({
      where: {
        id: { notIn: [userId, ...blockedUserIds] },
        isBanned: false,
        college: currentUser.college,
      },
      skip,
      take: limit + 1,
      orderBy: peopleOrderBy,
      select: personCardUserSelect,
    });

    const visibilityByUser = await getPremiumVisibilityByUserIds(users.map((user) => user.id));
    const hasMore = users.length > limit;
    const sortedUsers = sortByPremiumVisibility(users.slice(0, limit), visibilityByUser);
    const relationship = await getRelationshipSummary(userId, sortedUsers.map((user) => user.id));
    const people: PersonCard[] = sortedUsers.map((user) =>
      mapUserToPersonCard(user, relationship, visibilityByUser)
    );

    const response = {
      people,
      userCollege: currentUser.college,
      total: skip + people.length + (hasMore ? 1 : 0),
      page,
      totalPages: hasMore ? page + 1 : page,
      hasMore,
    };

    await cacheService.set(
      cacheKey,
      response,
      PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS,
      peopleCacheTags(userId)
    );

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching same college people:', error);
    res.status(500).json({ error: 'Failed to fetch people from same college' });
  }
};

/**
 * Search Google Places India, platform, catalog, and directory education institutions
 * GET /api/people/colleges?q=search_term
 * Returns school/college/institute names with member counts and optional logo metadata
 */
export const searchColleges = async (
  req: AuthenticatedRequest,
  res: Response<{ colleges: CollegeSuggestion[] } | ErrorResponse>
): Promise<void> => {
  try {
    const query = normalizeSearchText(req.query.q, 80);
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);

    const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
    const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;

    let userLat = lat;
    let userLng = lng;
    if (userLat === undefined || userLng === undefined) {
      if (req.user?.userId) {
        const user = await prismaRead.user.findUnique({
          where: { id: String(req.user.userId) },
          select: { latitude: true, longitude: true },
        });
        if (user?.latitude && user?.longitude) {
          userLat = user.latitude;
          userLng = user.longitude;
        }
      }
    }

    const latKey = userLat !== undefined ? Math.round(userLat * 10) / 10 : '';
    const lngKey = userLng !== undefined ? Math.round(userLng * 10) / 10 : '';
    const cacheKey = `${peopleCollegesCacheKey(query.toLowerCase(), limit)}:lat:${latKey}:lng:${lngKey}`;

    const cached = await cacheService.get<{ colleges: CollegeSuggestion[] }>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json({ colleges: withCollegeLogoProxyUrls(req, cached.colleges) });
      return;
    }

    const [collegeData, googlePlacesColleges, collegeDbColleges, directoryColleges] = await Promise.all([
      prismaRead.user.groupBy({
        by: ['college'],
        where: {
          isBanned: false,
          college: {
            not: null,
            ...(query ? { contains: query, mode: 'insensitive' } : {}),
          },
        },
        _count: {
          college: true,
        },
        orderBy: {
          _count: {
            college: 'desc',
          },
        },
        take: limit,
      }),
      fetchGooglePlacesSchoolSuggestions(query, limit, userLat, userLng),
      fetchCollegeDbSuggestions(query, limit),
      fetchDirectoryCollegeSuggestions(query, limit),
    ]);

    const platformColleges = collegeData
      .filter((c) => c.college !== null)
      .map((c) => ({
        name: c.college!,
        count: c._count.college,
      }));
    const catalogColleges = searchCatalogColleges(query, limit);
    const colleges = mergeCollegeSuggestions(platformColleges, googlePlacesColleges, collegeDbColleges, catalogColleges, directoryColleges, limit);

    const response = { colleges: withCollegeLogoProxyUrls(req, colleges) };
    await cacheService.set(
      cacheKey,
      { colleges },
      PEOPLE_COLLEGE_SEARCH_CACHE_TTL_SECONDS,
      ['people:filters']
    );

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error searching colleges:', error);
    res.status(500).json({ error: 'Failed to search colleges' });
  }
};

export const getCollegeLogo = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const domain = normalizeSearchText(req.query.domain, 120).toLowerCase();
    if (!domain) {
      res.status(400).json({ error: 'domain is required' });
      return;
    }

    const logo = await fetchCollegeLogoImage(domain);
    if (!logo) {
      res.status(404).json({ error: 'College logo not found' });
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', logo.contentType);
    res.send(logo.data);
  } catch (error) {
    console.error('Error proxying college logo:', error);
    res.status(500).json({ error: 'Failed to fetch college logo' });
  }
};
