import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prismaRead } from '../config/prisma';
import { cacheService } from '../services/cache.service';
import {
  applyPremiumVisibilityToUser,
  getPremiumVisibilityByUserIds,
  sortByPremiumVisibility,
  type PremiumVisibilityState,
} from '../services/premium-visibility.service';
import {
  buildPeopleDiscoveryWhere,
  buildPremiumRequiredDiscoveryResponse,
  createSavedDiscoverySearch,
  deleteSavedDiscoverySearch,
  getActiveDiscoveryPassTargetIds,
  getDiscoveryAccess,
  getSuggestionQuotaState,
  hasActiveDiscoveryPasses,
  hasPremiumPeopleDiscoveryFilters,
  listSavedDiscoverySearches,
  passDiscoveryUser,
  recordPeopleSearchAppearances,
  recordSuggestionImpressions,
  rewindLastDiscoveryPass,
  updateSavedDiscoverySearch,
} from '../services/discovery-power.service';
import { ensurePremiumFeatureAccess } from '../services/premium-feature-gates.service';
import {
  CollegeSuggestion,
  fetchCollegeDbSuggestions,
  fetchCollegeLogoImage,
  fetchDirectoryCollegeSuggestions,
  fetchGooglePlacesSchoolSuggestions,
  mergeCollegeSuggestions,
  searchCatalogColleges,
} from '../services/college-catalog.service';
import { getBlockedUserIds } from '../services/trust-safety.service';
import { getPeopleRelationshipCapabilities } from '../services/people-relationship.service';
import { decorateSurfaceRecommendations } from '../services/surface-recommendation.service';
import {
  CoarseLocationDTO,
  serializeCoarseLocation,
} from '../utils/location-dto.util';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  nullableDateDescIdAscWhere,
} from '../utils/keyset-pagination.util';

interface PersonCard {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  bannerImageUrl: string | null;
  headline: string | null;
  college: string | null;
  branch: string | null;
  bio: string | null;
  location: CoarseLocationDTO | null;
  skills: string[];
  interests: string[];
  isOnline: boolean;
  verified: boolean;
  isVerified: boolean;
  profileBadgeStyle?: string | null;
  isPremium: boolean;
  profileBoostActive: boolean;
  profileBoostEndsAt?: string | null;
  profileBoostPriority?: number;
  discoveryPriority?: number;
  connectionStatus: 'none' | 'pending_sent' | 'pending_received' | 'connected';
  connectionId: string | null;
  relationship: {
    status: 'none' | 'pending_sent' | 'pending_received' | 'connected';
    connectionId: string | null;
  };
  mutualConnections?: number;
}

interface PeopleResponse {
  people: PersonCard[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
  nextCursor?: string | null;
  totalIsApproximate?: boolean;
}

interface SuggestionQuota {
  isPremium: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  window: 'day';
  resetsAt: string | null;
}

interface FilterOptions {
  colleges: string[];
  branches: string[];
  graduationYears: number[];
  locations: string[];
}

const PEOPLE_CACHE_VERSION = 'v6';
const PEOPLE_GLOBAL_CACHE_TAG = 'people:global';
const PEOPLE_PUBLIC_CACHE_TTL_SECONDS = 15;
const PEOPLE_AUTH_CACHE_TTL_SECONDS = 30;
const PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS = 60;
const PEOPLE_FILTER_OPTIONS_CACHE_KEY = 'people:filter-options:v1';
const PEOPLE_FILTER_OPTIONS_CACHE_TTL_SECONDS = 5 * 60;
const PEOPLE_ACCEPTED_CONNECTION_IDS_CACHE_TTL_SECONDS = 30;
const PEOPLE_FILTER_OPTION_LIMIT = 100;
const PEOPLE_DEFAULT_LIMIT = 20;
const PEOPLE_BROWSE_DEFAULT_LIMIT = 30;
const PEOPLE_SEARCH_DEFAULT_LIMIT = 20;
const PEOPLE_SEARCH_MAX_LIMIT = 30;
const PEOPLE_MAX_LIMIT = 50;
const PEOPLE_PERSONALIZED_MAX_LIMIT = 50;
const PEOPLE_MAX_FILTER_VALUES = 10;
const PEOPLE_MAX_PERSON_CARD_SKILLS = 8;
const PEOPLE_MAX_ACCEPTED_CONNECTION_IDS = 1_000;
const PEOPLE_MAX_MUTUAL_CONNECTION_SCAN_IDS = 500;
const PEOPLE_SUGGESTION_POOL_MAX = 80;
const PEOPLE_MIN_TEXT_SEARCH_LENGTH = 2;
const PEOPLE_COLLEGE_SEARCH_CACHE_TTL_SECONDS = 5 * 60;
const PEOPLE_NEAR_ME_CACHE_TTL_SECONDS = 60;
const PEOPLE_LIST_CACHE_QUERY_KEYS = new Set([
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
  'page',
  'limit',
  'cursor',
  'includeTotal',
  'includeMutuals',
  'includeMutualConnections',
]);
const PEOPLE_SEARCH_APPEARANCE_QUERY_KEYS = new Set([
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

type PeopleCursor = {
  id: string;
  lastActiveAt: string | null;
};

type RelationshipSummary = {
  connectionStatusByUser: Map<string, PersonCard['connectionStatus']>;
  connectionIdByUser: Map<string, string>;
  mutualConnectionsByUser: Map<string, number>;
};

type PeopleSearchRankRow = {
  id: string;
  rank: number;
  lastActiveAt: Date | null;
};

const emptyRelationshipSummary = (): RelationshipSummary => ({
  connectionStatusByUser: new Map<string, PersonCard['connectionStatus']>(),
  connectionIdByUser: new Map<string, string>(),
  mutualConnectionsByUser: new Map<string, number>(),
});

const normalizeSearchText = (value: unknown, maxLength = 80): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

const titleCaseSearchValue = (value: string): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');

const interestSearchVariants = (value: string): string[] =>
  Array.from(new Set([value, value.toLowerCase(), titleCaseSearchValue(value)].filter(Boolean)));

const shouldIncludeTotal = (value: unknown): boolean => value === 'true' || value === '1';

const parseBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = parseInt(String(value ?? ''), 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, normalized));
};

const splitQueryList = (value: unknown): string[] => {
  if (typeof value !== 'string') return [];
  return Array.from(new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, PEOPLE_MAX_FILTER_VALUES)
  ));
};

const shouldBypassPeopleCache = (req: AuthenticatedRequest): boolean => {
  const cacheControl = String(req.headers['cache-control'] || '').toLowerCase();
  return (
    cacheControl.includes('no-cache') ||
    Boolean(normalizeSearchText(req.query.cacheBust, 40)) ||
    Boolean(normalizeSearchText(req.query._t, 40))
  );
};

const shouldRecordPeopleSearchAppearances = (
  userId: string | null,
  query: AuthenticatedRequest['query']
): userId is string => {
  if (!userId) return false;
  return Object.entries(query).some(([key, value]) => {
    if (!PEOPLE_SEARCH_APPEARANCE_QUERY_KEYS.has(key)) return false;
    if (key === 'scope') {
      return normalizeSearchText(value, 20).toLowerCase() === 'global';
    }
    if (key === 'isOpenToOpportunities' || key === 'verifiedOnly') {
      const normalized = normalizeSearchText(value, 20).toLowerCase();
      return normalized === 'true' || normalized === '1';
    }
    return normalizeQueryValue(value).trim().length > 0;
  });
};

const recordPeopleSearchAppearancesIfNeeded = async (
  userId: string | null,
  query: AuthenticatedRequest['query'],
  people: Array<{ id: string }>
): Promise<void> => {
  if (!shouldRecordPeopleSearchAppearances(userId, query) || people.length === 0) return;
  try {
    await recordPeopleSearchAppearances(userId, people.map((person) => person.id));
  } catch (error) {
    console.warn('Failed to record people search appearances:', error);
  }
};

const encodePeopleCursor = (user: { id: string; lastActiveAt?: Date | string | null }): string => {
  return encodeKeysetCursor({
    scope: 'people.discovery',
    id: user.id,
    t: user.lastActiveAt
      ? new Date(user.lastActiveAt).toISOString()
      : null,
  });
};

const decodePeopleCursor = (value: unknown): PeopleCursor | null => {
  const signedCursor = decodeKeysetCursor(value, 'people.discovery');
  if (signedCursor) {
    return { id: signedCursor.id, lastActiveAt: signedCursor.t ?? null };
  }

  if (typeof value !== 'string' || value.trim() === '' || value.includes('.')) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PeopleCursor>;
    if (!decoded || typeof decoded.id !== 'string') return null;
    if (decoded.lastActiveAt !== null && typeof decoded.lastActiveAt !== 'string') return null;

    return {
      id: decoded.id,
      lastActiveAt: decoded.lastActiveAt ?? null,
    };
  } catch {
    return null;
  }
};

const buildCursorWhere = (cursor: PeopleCursor | null): any | null => {
  return nullableDateDescIdAscWhere(
    cursor ? { id: cursor.id, t: cursor.lastActiveAt, scope: 'people.discovery' } : null,
    'lastActiveAt'
  );
};

const peopleOrderBy: any[] = [
  { lastActiveAt: { sort: 'desc', nulls: 'last' } },
  { id: 'asc' },
];

const normalizeQueryValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(String).sort().join(',').slice(0, 160);
  }
  return String(value ?? '').slice(0, 160);
};

const serializeQuery = (query: AuthenticatedRequest['query']): string =>
  Object.entries(query)
    .filter(([key]) => PEOPLE_LIST_CACHE_QUERY_KEYS.has(key))
    .map(([key, value]) => [key, normalizeQueryValue(value)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

const buildPeopleListCacheKey = (
  userId: string | null,
  query: AuthenticatedRequest['query']
): string => {
  const scope = userId ? `user:${userId}` : 'public';
  const serializedQuery = serializeQuery(query);
  const queryKey = serializedQuery
    ? createHash('sha256').update(serializedQuery).digest('hex').slice(0, 32)
    : 'default';
  return `people:list:${PEOPLE_CACHE_VERSION}:${scope}:${queryKey}`;
};

const getAcceptedConnectionIdsCacheKey = (userId: string): string =>
  `people:accepted-connections:${userId}`;

const peopleCollegesCacheKey = (query: string, limit: number): string =>
  `people:colleges:${PEOPLE_CACHE_VERSION}:q:${createHash('sha256').update(query).digest('hex').slice(0, 24)}:limit:${limit}`;

const peopleCollegeLogoProxyUrl = (req: AuthenticatedRequest, domain?: string | null): string | null => {
  const normalizedDomain = normalizeSearchText(domain, 120).toLowerCase();
  if (!normalizedDomain) return null;
  const forwardedProto = normalizeSearchText(req.headers['x-forwarded-proto'], 20).split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = req.get('host');
  if (!host) return null;
  return `${protocol}://${host}${req.baseUrl}/college-logo?domain=${encodeURIComponent(normalizedDomain)}`;
};

const withCollegeLogoProxyUrls = (
  req: AuthenticatedRequest,
  colleges: CollegeSuggestion[]
): CollegeSuggestion[] =>
  colleges.map((college) => ({
    ...college,
    logoUrl: peopleCollegeLogoProxyUrl(req, college.domain) || college.logoUrl,
  }));

const peopleNearMeCacheKey = (userId: string, limit: number): string =>
  `people:near-me:${PEOPLE_CACHE_VERSION}:user:${userId}:limit:${limit}`;

const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

const peopleCacheTags = (userId?: string | null): string[] =>
  uniqueCacheTags([
    PEOPLE_GLOBAL_CACHE_TAG,
    userId ? `people:user:${userId}` : 'people:public',
    userId ? `people:connections:${userId}` : '',
  ]);

const peopleSameCollegeCacheKey = (userId: string, page: number, limit: number): string =>
  `people:same-college:${PEOPLE_CACHE_VERSION}:user:${userId}:page:${page}:limit:${limit}`;

const filterBlockedPeople = <T extends { id: string }>(people: T[], blockedUserIds: string[]): T[] => {
  if (blockedUserIds.length === 0) return people;
  const blockedSet = new Set(blockedUserIds);
  return people.filter((person) => !blockedSet.has(person.id));
};

const personCardUserSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  bannerImageUrl: true,
  headline: true,
  college: true,
  branch: true,
  bio: true,
  currentCity: true,
  currentState: true,
  currentCountry: true,
  interests: true,
  isOnline: true,
  isVerified: true,
  profileBadgeStyle: true,
  skills: {
    take: PEOPLE_MAX_PERSON_CARD_SKILLS,
    select: { skill: { select: { name: true } } },
  },
};

const personCardUserSelectWithCursor = {
  ...personCardUserSelect,
  lastActiveAt: true,
};

const getAcceptedConnectionIds = async (userId: string): Promise<string[]> => {
  const cacheKey = getAcceptedConnectionIdsCacheKey(userId);
  const cached = await cacheService.get<string[]>(cacheKey);
  if (cached) return cached;

  const currentUserConnections = await prismaRead.connections.findMany({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: userId },
        { addresseeId: userId },
      ],
    },
    select: { requesterId: true, addresseeId: true },
    orderBy: { updatedAt: 'desc' },
    take: PEOPLE_MAX_ACCEPTED_CONNECTION_IDS,
  });

  const ids = Array.from(new Set(
    currentUserConnections.map((connection) =>
      connection.requesterId === userId ? connection.addresseeId : connection.requesterId
    )
  ));

  await cacheService.set(
    cacheKey,
    ids,
    PEOPLE_ACCEPTED_CONNECTION_IDS_CACHE_TTL_SECONDS,
    [`people:connections:${userId}`]
  );

  return ids;
};

const getRelationshipSummary = async (
  currentUserId: string | null,
  targetIds: string[],
  includeMutualConnections = true
): Promise<RelationshipSummary> => {
  if (!currentUserId || targetIds.length === 0) {
    return emptyRelationshipSummary();
  }

  const uniqueTargetIds = Array.from(new Set(targetIds));
  const targetIdSet = new Set(uniqueTargetIds);
  const connectionStatusByUser = new Map<string, PersonCard['connectionStatus']>();
  const connectionIdByUser = new Map<string, string>();
  const mutualConnectionsByUser = new Map<string, number>();

  const [capabilities, currentConnectionIds] = await Promise.all([
    getPeopleRelationshipCapabilities(currentUserId, uniqueTargetIds),
    includeMutualConnections ? getAcceptedConnectionIds(currentUserId) : Promise.resolve([]),
  ]);

  for (const [targetUserId, capability] of capabilities) {
    if (capability.connectionStatus !== 'none') {
      connectionStatusByUser.set(targetUserId, capability.connectionStatus);
    }
    if (capability.connectionId) {
      connectionIdByUser.set(targetUserId, capability.connectionId);
    }
  }

  const mutualConnectionIds = currentConnectionIds.slice(0, PEOPLE_MAX_MUTUAL_CONNECTION_SCAN_IDS);
  if (includeMutualConnections && mutualConnectionIds.length > 0) {
    const mutualRows = await prismaRead.connections.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: { in: uniqueTargetIds }, addresseeId: { in: mutualConnectionIds } },
          { requesterId: { in: mutualConnectionIds }, addresseeId: { in: uniqueTargetIds } },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const mutualSetsByUser = new Map<string, Set<string>>();
    for (const connection of mutualRows) {
      const targetUserId = targetIdSet.has(connection.requesterId)
        ? connection.requesterId
        : targetIdSet.has(connection.addresseeId)
          ? connection.addresseeId
          : null;
      if (!targetUserId) continue;

      const mutualUserId = connection.requesterId === targetUserId
        ? connection.addresseeId
        : connection.requesterId;
      const mutualSet = mutualSetsByUser.get(targetUserId) || new Set<string>();
      mutualSet.add(mutualUserId);
      mutualSetsByUser.set(targetUserId, mutualSet);
    }

    for (const [targetUserId, mutualSet] of mutualSetsByUser) {
      mutualConnectionsByUser.set(targetUserId, mutualSet.size);
    }
  }

  return { connectionStatusByUser, connectionIdByUser, mutualConnectionsByUser };
};

const peopleSearchScope = (query: string): string =>
  `people.search.${createHash('sha256').update(query).digest('hex').slice(0, 20)}`;

const decodePeopleSearchCursor = (value: unknown, query: string) =>
  decodeKeysetCursor(value, peopleSearchScope(query));

const encodePeopleSearchCursor = (row: PeopleSearchRankRow, query: string): string =>
  encodeKeysetCursor({
    scope: peopleSearchScope(query),
    id: row.id,
    n: Number(row.rank),
    t: row.lastActiveAt?.toISOString() ?? null,
  });

const mapUserToPersonCard = (
  user: any,
  relationship: RelationshipSummary,
  visibilityByUser: Map<string, PremiumVisibilityState> = new Map()
): PersonCard => {
  const visibleUser = applyPremiumVisibilityToUser(user, visibilityByUser);
  const connectionStatus = relationship.connectionStatusByUser.get(visibleUser.id) || 'none';
  const connectionId = relationship.connectionIdByUser.get(visibleUser.id) || null;
  return {
    id: visibleUser.id,
    username: visibleUser.username,
    name: visibleUser.name,
    profileImage: visibleUser.profileImage,
    bannerImageUrl: visibleUser.bannerImageUrl,
    headline: visibleUser.headline,
    college: visibleUser.college,
    branch: visibleUser.branch,
    bio: visibleUser.bio,
    location: serializeCoarseLocation(visibleUser),
    skills: visibleUser.skills?.map((s: any) => s.skill.name) || [],
    interests: visibleUser.interests || [],
    isOnline: visibleUser.isOnline,
    verified: Boolean(visibleUser.isVerified),
    isVerified: Boolean(visibleUser.isVerified),
    profileBadgeStyle: visibleUser.profileBadgeStyle ?? null,
    isPremium: visibleUser.isPremium,
    profileBoostActive: visibleUser.profileBoostActive,
    profileBoostEndsAt: visibleUser.profileBoostEndsAt,
    profileBoostPriority: visibleUser.profileBoostPriority,
    discoveryPriority: visibleUser.discoveryPriority,
    connectionStatus,
    connectionId,
    relationship: {
      status: connectionStatus,
      connectionId,
    },
    mutualConnections: relationship.mutualConnectionsByUser.get(visibleUser.id) || 0,
  };
};

const getConnectionStatus = async (
  currentUserId: string,
  targetUserId: string
): Promise<'none' | 'pending_sent' | 'pending_received' | 'connected'> => {
  const connection = await prismaRead.connections.findFirst({
    where: {
      OR: [
        { requesterId: currentUserId, addresseeId: targetUserId },
        { requesterId: targetUserId, addresseeId: currentUserId },
      ],
    },
  });

  if (!connection) return 'none';
  if (connection.status === 'accepted') return 'connected';
  if (connection.status === 'pending') {
    return connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received';
  }
  return 'none';
};

const getMutualConnectionsCount = async (
  userId1: string,
  userId2: string
): Promise<number> => {
  const user1Connections = await prismaRead.connections.findMany({
    where: {
      OR: [
        { requesterId: userId1, status: 'accepted' },
        { addresseeId: userId1, status: 'accepted' },
      ],
    },
    select: { requesterId: true, addresseeId: true },
  });

  const user1ConnectionIds = new Set(
    user1Connections.map((c) =>
      c.requesterId === userId1 ? c.addresseeId : c.requesterId
    )
  );

  const user2Connections = await prismaRead.connections.findMany({
    where: {
      OR: [
        { requesterId: userId2, status: 'accepted' },
        { addresseeId: userId2, status: 'accepted' },
      ],
    },
    select: { requesterId: true, addresseeId: true },
  });

  let mutualCount = 0;
  for (const c of user2Connections) {
    const connectedUserId = c.requesterId === userId2 ? c.addresseeId : c.requesterId;
    if (user1ConnectionIds.has(connectedUserId)) {
      mutualCount++;
    }
  }

  return mutualCount;
};

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
    const normalizedSearch = rawSearch.length >= PEOPLE_MIN_TEXT_SEARCH_LENGTH ? rawSearch : '';
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

/**
 * Global indexed people search.
 * GET /api/people/search?q=&cursor=&limit=20
 */
export const searchPeople = async (
  req: AuthenticatedRequest,
  res: Response<PeopleResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const normalizedQuery = normalizeSearchText(req.query.q, 80).toLowerCase();
    if (normalizedQuery.length < PEOPLE_MIN_TEXT_SEARCH_LENGTH) {
      res.status(200).json({
        people: [],
        total: 0,
        page: 1,
        totalPages: 1,
        hasMore: false,
        nextCursor: null,
      });
      return;
    }

    const cursor = decodePeopleSearchCursor(req.query.cursor, normalizedQuery);
    if (req.query.cursor && !cursor) {
      res.status(400).json({ error: 'Invalid or expired search cursor' });
      return;
    }
    if (cursor?.n === undefined) {
      if (req.query.cursor) {
        res.status(400).json({ error: 'Invalid search cursor' });
        return;
      }
    }

    const cursorDate = cursor?.t ? new Date(cursor.t) : null;
    if (cursorDate && Number.isNaN(cursorDate.getTime())) {
      res.status(400).json({ error: 'Invalid search cursor' });
      return;
    }

    const limit = parseBoundedInt(
      req.query.limit,
      PEOPLE_SEARCH_DEFAULT_LIMIT,
      1,
      PEOPLE_SEARCH_MAX_LIMIT
    );
    const blockedUserIds = await getBlockedUserIds(userId);
    const blockedClause = blockedUserIds.length
      ? Prisma.sql`AND u."id" NOT IN (${Prisma.join(blockedUserIds)})`
      : Prisma.empty;
    const cursorClause = !cursor
      ? Prisma.empty
      : cursorDate
        ? Prisma.sql`WHERE (
            "rank" < ${cursor.n!}
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" < ${cursorDate})
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" = ${cursorDate} AND "id" > ${cursor.id})
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" IS NULL)
          )`
        : Prisma.sql`WHERE (
            "rank" < ${cursor.n!}
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" IS NULL AND "id" > ${cursor.id})
          )`;

    const queryHash = createHash('sha256')
      .update(`${normalizedQuery}|${String(req.query.cursor || '')}|${limit}`)
      .digest('hex')
      .slice(0, 32);
    const cacheKey = `people:search:${PEOPLE_CACHE_VERSION}:user:${userId}:${queryHash}`;
    const bypassCache = shouldBypassPeopleCache(req);

    const computeResponse = async (): Promise<PeopleResponse> => {
      const rankedRows = await prismaRead.$queryRaw<PeopleSearchRankRow[]>(Prisma.sql`
        WITH ranked_people AS (
          SELECT
            u."id",
            u."lastActiveAt",
            (
              CASE
                WHEN lower(u."username") = ${normalizedQuery} THEN 1000
                WHEN lower(u."name") = ${normalizedQuery} THEN 900
                WHEN lower(u."username") LIKE ${`${normalizedQuery}%`} THEN 800
                WHEN lower(u."name") LIKE ${`${normalizedQuery}%`} THEN 700
                WHEN lower(COALESCE(u."college", '')) = ${normalizedQuery} THEN 600
                WHEN lower(COALESCE(u."college", '')) LIKE ${`${normalizedQuery}%`} THEN 550
                ELSE 100
              END
              + COALESCE(ts_rank_cd(d."searchVector", websearch_to_tsquery('english', ${normalizedQuery})), 0) * 100
            )::double precision AS "rank"
          FROM "users" u
          LEFT JOIN "discovery_documents" d
            ON d."entityType" = 'profile' AND d."entityId" = u."id"
          WHERE u."id" <> ${userId}
            AND u."isBanned" = false
            ${blockedClause}
            AND (
              lower(u."username") = ${normalizedQuery}
              OR lower(u."name") = ${normalizedQuery}
              OR lower(u."username") LIKE ${`${normalizedQuery}%`}
              OR lower(u."name") LIKE ${`${normalizedQuery}%`}
              OR lower(COALESCE(u."college", '')) LIKE ${`${normalizedQuery}%`}
              OR d."searchVector" @@ websearch_to_tsquery('english', ${normalizedQuery})
            )
        )
        SELECT "id", "rank", "lastActiveAt"
        FROM ranked_people
        ${cursorClause}
        ORDER BY "rank" DESC, "lastActiveAt" DESC NULLS LAST, "id" ASC
        LIMIT ${limit + 1}
      `);

      const pageRows = rankedRows.slice(0, limit);
      const users = pageRows.length
        ? await prismaRead.user.findMany({
            where: { id: { in: pageRows.map((row) => row.id) }, isBanned: false },
            select: personCardUserSelectWithCursor,
          })
        : [];
      const userById = new Map(users.map((user) => [user.id, user]));
      const orderedUsers = pageRows.flatMap((row) => {
        const user = userById.get(row.id);
        return user ? [user] : [];
      });
      const [visibilityByUser, relationship] = await Promise.all([
        getPremiumVisibilityByUserIds(orderedUsers.map((user) => user.id)),
        getRelationshipSummary(userId, orderedUsers.map((user) => user.id), false),
      ]);
      const people = orderedUsers.map((user) =>
        mapUserToPersonCard(user, relationship, visibilityByUser)
      );
      const hasMore = rankedRows.length > limit;
      const boundary = pageRows[pageRows.length - 1];

      return {
        people,
        total: people.length + (hasMore ? 1 : 0),
        page: 1,
        totalPages: hasMore ? 2 : 1,
        hasMore,
        nextCursor: hasMore && boundary
          ? encodePeopleSearchCursor(boundary, normalizedQuery)
          : null,
        totalIsApproximate: true,
      };
    };

    const response = bypassCache
      ? await computeResponse()
      : await cacheService.getOrSet(cacheKey, computeResponse, {
          tags: peopleCacheTags(userId),
          swr: {
            softTtlSeconds: PEOPLE_AUTH_CACHE_TTL_SECONDS,
            hardTtlSeconds: PEOPLE_AUTH_CACHE_TTL_SECONDS * 4,
          },
        });

    void recordPeopleSearchAppearancesIfNeeded(
      userId,
      { ...req.query, search: normalizedQuery },
      response.people
    );
    res.setHeader('X-Vormex-Cache', bypassCache ? 'BYPASS' : 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error searching people:', error);
    res.status(500).json({ error: 'Failed to search people' });
  }
};

/**
 * Get personalized suggestions
 * GET /api/people/suggestions
 */
export const getSuggestions = async (
  req: AuthenticatedRequest,
  res: Response<{
    suggestions: PersonCard[];
    total?: number;
    hasMore?: boolean;
    quota?: SuggestionQuota;
    canRewind?: boolean;
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
    const quota = await getSuggestionQuotaState(userId);
    const effectiveLimit = quota.isPremium
      ? limit
      : Math.min(limit, quota.remaining ?? 0);
    const canRewind = await hasActiveDiscoveryPasses(userId);

    if (effectiveLimit <= 0) {
      res.setHeader('X-Vormex-Cache', 'BYPASS');
      res.status(200).json({
        suggestions: [],
        total: 0,
        hasMore: false,
        quota,
        canRewind,
      });
      return;
    }

    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { college: true, branch: true, interests: true, graduationYear: true },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [passedTargetIds, blockedUserIds] = await Promise.all([
      getActiveDiscoveryPassTargetIds(userId),
      getBlockedUserIds(userId),
    ]);

    const suggestionSignals: any[] = [];
    if (currentUser.college) suggestionSignals.push({ college: currentUser.college });
    if (currentUser.branch) suggestionSignals.push({ branch: currentUser.branch });
    if (currentUser.interests.length > 0) {
      suggestionSignals.push({ interests: { hasSome: currentUser.interests } });
    }
    if (currentUser.graduationYear) suggestionSignals.push({ graduationYear: currentUser.graduationYear });

    const users = await prismaRead.user.findMany({
      where: {
        id: { notIn: [userId, ...passedTargetIds, ...blockedUserIds] },
        isBanned: false,
        ...(suggestionSignals.length > 0 ? { OR: suggestionSignals } : {}),
      },
      skip,
      take: effectiveLimit,
      orderBy: peopleOrderBy,
      select: personCardUserSelect,
    });

    const visibilityByUser = await getPremiumVisibilityByUserIds(users.map((user) => user.id));
    const relationship = await getRelationshipSummary(userId, users.map((user) => user.id));
    const suggestions: PersonCard[] = sortByPremiumVisibility(
      users.filter((user) => !relationship.connectionStatusByUser.has(user.id)),
      visibilityByUser
    ).map((user) => mapUserToPersonCard(user, relationship, visibilityByUser));
    const updatedQuota = await recordSuggestionImpressions(
      userId,
      suggestions.map((suggestion) => suggestion.id),
      quota
    );
    const decorated = await decorateSurfaceRecommendations({
      userId,
      surface: 'PEOPLE',
      entityType: 'PERSON',
      items: suggestions,
      authorIdOf: (person) => person.id,
      pageSize: suggestions.length || 1,
    });
    const response = {
      suggestions: decorated.items,
      total: skip + suggestions.length + (users.length === effectiveLimit ? 1 : 0),
      page,
      hasMore:
        users.length === effectiveLimit &&
        (updatedQuota.isPremium || (updatedQuota.remaining ?? 0) > 0),
      quota: updatedQuota,
      canRewind,
      recommendationSessionId: decorated.recommendationSessionId,
      requestId: decorated.requestId,
      rankerVersion: decorated.rankerVersion,
      experimentVariant: decorated.experimentVariant,
    };

    res.setHeader('X-Vormex-Cache', 'BYPASS');
    res.status(200).json(response as any);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
};

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
  req: AuthenticatedRequest,
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
        where: { isBanned: false, currentCity: { not: null } },
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

export const passDiscoverySuggestion = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string; targetUserId: string; canRewind: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const targetUserId = normalizeSearchText(req.body?.targetUserId || req.body?.userId, 80);
    if (!targetUserId) {
      res.status(400).json({ error: 'targetUserId is required' });
      return;
    }

    await passDiscoveryUser(userId, targetUserId);
    res.status(200).json({
      message: 'Suggestion passed',
      targetUserId,
      canRewind: true,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to pass suggestion';
    res.status(message === 'User not found' ? 404 : 400).json({ error: message });
  }
};

export const rewindDiscoveryPass = async (
  req: AuthenticatedRequest,
  res: Response<{ rewound: boolean; targetUserId?: string | null; canRewind: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const premiumAccess = await ensurePremiumFeatureAccess(userId, 'discovery_rewind');
    if (premiumAccess.ok === false) {
      res.status(premiumAccess.statusCode).json(premiumAccess.payload);
      return;
    }

    const rewound = await rewindLastDiscoveryPass(userId);
    res.status(200).json({
      rewound: Boolean(rewound),
      targetUserId: rewound?.targetUserId || null,
      canRewind: await hasActiveDiscoveryPasses(userId),
    });
  } catch (error) {
    console.error('Error rewinding discovery pass:', error);
    res.status(500).json({ error: 'Failed to rewind suggestion' });
  }
};

export const getSavedDiscoverySearches = async (
  req: AuthenticatedRequest,
  res: Response<{ searches: any[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const searches = await listSavedDiscoverySearches(userId);
    res.status(200).json({ searches });
  } catch (error) {
    console.error('Error fetching saved discovery searches:', error);
    res.status(500).json({ error: 'Failed to fetch saved searches' });
  }
};

export const createSavedDiscoverySearchController = async (
  req: AuthenticatedRequest,
  res: Response<{ search: any } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const search = await createSavedDiscoverySearch(userId, req.body || {});
    res.status(201).json({ search });
  } catch (error) {
    console.error('Error creating saved discovery search:', error);
    res.status(500).json({ error: 'Failed to save search' });
  }
};

export const updateSavedDiscoverySearchController = async (
  req: AuthenticatedRequest,
  res: Response<{ search: any } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const searchId = normalizeSearchText(req.params.id, 80);
    const search = await updateSavedDiscoverySearch(userId, searchId, req.body || {});
    if (!search) {
      res.status(404).json({ error: 'Saved search not found' });
      return;
    }

    res.status(200).json({ search });
  } catch (error) {
    console.error('Error updating saved discovery search:', error);
    res.status(500).json({ error: 'Failed to update saved search' });
  }
};

export const deleteSavedDiscoverySearchController = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const searchId = normalizeSearchText(req.params.id, 80);
    const deleted = await deleteSavedDiscoverySearch(userId, searchId);
    if (!deleted) {
      res.status(404).json({ error: 'Saved search not found' });
      return;
    }

    res.status(200).json({ message: 'Saved search deleted' });
  } catch (error) {
    console.error('Error deleting saved discovery search:', error);
    res.status(500).json({ error: 'Failed to delete saved search' });
  }
};
