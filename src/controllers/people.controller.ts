import { createHash } from 'crypto';
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prismaRead } from '../config/prisma';
import { cacheService } from '../services/cache.service';

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
  skills: string[];
  interests: string[];
  isOnline: boolean;
  verified: boolean;
  isVerified: boolean;
  connectionStatus: 'none' | 'pending_sent' | 'pending_received' | 'connected';
  mutualConnections?: number;
}

interface PeopleResponse {
  people: PersonCard[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
  nextCursor?: string | null;
}

interface FilterOptions {
  colleges: string[];
  branches: string[];
  graduationYears: number[];
  locations: string[];
}

const PEOPLE_CACHE_VERSION = 'v2';
const PEOPLE_GLOBAL_CACHE_TAG = 'people:global';
const PEOPLE_PUBLIC_CACHE_TTL_SECONDS = 15;
const PEOPLE_AUTH_CACHE_TTL_SECONDS = 30;
const PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS = 60;
const PEOPLE_FILTER_OPTIONS_CACHE_KEY = 'people:filter-options:v1';
const PEOPLE_FILTER_OPTIONS_CACHE_TTL_SECONDS = 5 * 60;
const PEOPLE_ACCEPTED_CONNECTION_IDS_CACHE_TTL_SECONDS = 30;
const PEOPLE_FILTER_OPTION_LIMIT = 100;
const PEOPLE_DEFAULT_LIMIT = 20;
const PEOPLE_MAX_LIMIT = 40;
const PEOPLE_PERSONALIZED_MAX_LIMIT = 20;
const PEOPLE_MAX_OFFSET_PAGE = 25;
const PEOPLE_MAX_FILTER_VALUES = 10;
const PEOPLE_MAX_PERSON_CARD_SKILLS = 8;
const PEOPLE_MAX_ACCEPTED_CONNECTION_IDS = 1_000;
const PEOPLE_MAX_MUTUAL_CONNECTION_SCAN_IDS = 500;
const PEOPLE_SUGGESTION_POOL_MULTIPLIER = 4;
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
  'page',
  'limit',
  'cursor',
  'includeTotal',
  'includeMutuals',
  'includeMutualConnections',
]);

type PeopleCursor = {
  id: string;
  lastActiveAt: string | null;
};

type RelationshipSummary = {
  connectionStatusByUser: Map<string, PersonCard['connectionStatus']>;
  mutualConnectionsByUser: Map<string, number>;
};

const emptyRelationshipSummary = (): RelationshipSummary => ({
  connectionStatusByUser: new Map<string, PersonCard['connectionStatus']>(),
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

const encodePeopleCursor = (user: { id: string; lastActiveAt?: Date | string | null }): string => {
  const payload: PeopleCursor = {
    id: user.id,
    lastActiveAt: user.lastActiveAt
      ? new Date(user.lastActiveAt).toISOString()
      : null,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64url');
};

const decodePeopleCursor = (value: unknown): PeopleCursor | null => {
  if (typeof value !== 'string' || value.trim() === '') return null;

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
  if (!cursor) return null;

  if (!cursor.lastActiveAt) {
    return {
      lastActiveAt: null,
      id: { gt: cursor.id },
    };
  }

  const cursorDate = new Date(cursor.lastActiveAt);
  if (Number.isNaN(cursorDate.getTime())) return null;

  return {
    OR: [
      { lastActiveAt: { lt: cursorDate } },
      { lastActiveAt: cursorDate, id: { gt: cursor.id } },
      { lastActiveAt: null },
    ],
  };
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

const peopleNearMeCacheKey = (userId: string, limit: number): string =>
  `people:near-me:${PEOPLE_CACHE_VERSION}:user:${userId}:limit:${limit}`;

const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

const peopleCacheTags = (userId?: string | null): string[] =>
  uniqueCacheTags([
    PEOPLE_GLOBAL_CACHE_TAG,
    userId ? `people:user:${userId}` : 'people:public',
    userId ? `people:connections:${userId}` : '',
  ]);

const peopleSuggestionsCacheKey = (userId: string, limit: number): string =>
  `people:suggestions:${PEOPLE_CACHE_VERSION}:user:${userId}:limit:${limit}`;

const peopleSameCollegeCacheKey = (userId: string, limit: number): string =>
  `people:same-college:${PEOPLE_CACHE_VERSION}:user:${userId}:limit:${limit}`;

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
  interests: true,
  isOnline: true,
  isVerified: true,
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
  const mutualConnectionsByUser = new Map<string, number>();

  const [directConnections, currentConnectionIds] = await Promise.all([
    prismaRead.connections.findMany({
      where: {
        OR: [
          { requesterId: currentUserId, addresseeId: { in: uniqueTargetIds } },
          { requesterId: { in: uniqueTargetIds }, addresseeId: currentUserId },
        ],
      },
      select: { requesterId: true, addresseeId: true, status: true },
    }),
    includeMutualConnections ? getAcceptedConnectionIds(currentUserId) : Promise.resolve([]),
  ]);

  for (const connection of directConnections) {
    const targetUserId = connection.requesterId === currentUserId
      ? connection.addresseeId
      : connection.requesterId;
    if (connection.status === 'accepted') {
      connectionStatusByUser.set(targetUserId, 'connected');
    } else if (connection.status === 'pending') {
      connectionStatusByUser.set(
        targetUserId,
        connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received'
      );
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

  return { connectionStatusByUser, mutualConnectionsByUser };
};

const mapUserToPersonCard = (user: any, relationship: RelationshipSummary): PersonCard => ({
  id: user.id,
  username: user.username,
  name: user.name,
  profileImage: user.profileImage,
  bannerImageUrl: user.bannerImageUrl,
  headline: user.headline,
  college: user.college,
  branch: user.branch,
  bio: user.bio,
  skills: user.skills?.map((s: any) => s.skill.name) || [],
  interests: user.interests || [],
  isOnline: user.isOnline,
  verified: Boolean(user.isVerified),
  isVerified: Boolean(user.isVerified),
  connectionStatus: relationship.connectionStatusByUser.get(user.id) || 'none',
  mutualConnections: relationship.mutualConnectionsByUser.get(user.id) || 0,
});

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
    const {
      search,
      college,
      branch,
      graduationYear,
      skills,
      interests,
      location,
      isOpenToOpportunities,
    } = req.query;

    const cursor = decodePeopleCursor(req.query.cursor);
    const requestedPage = parseBoundedInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    if (!cursor && requestedPage > PEOPLE_MAX_OFFSET_PAGE) {
      res.status(400).json({ error: 'Use cursor pagination for deeper people discovery pages' });
      return;
    }

    const page = cursor ? 1 : requestedPage;
    const limit = parseBoundedInt(req.query.limit, PEOPLE_DEFAULT_LIMIT, 1, PEOPLE_MAX_LIMIT);
    const skip = (page - 1) * limit;
    const includeTotal = shouldIncludeTotal(req.query.includeTotal);
    const includeMutualConnections = req.query.includeMutuals !== 'false' && req.query.includeMutualConnections !== 'false';
    const cursorWhere = buildCursorWhere(cursor);
    const cacheKey = buildPeopleListCacheKey(userId, req.query);
    const rawSearch = normalizeSearchText(search);
    const hasSearchParam = typeof search === 'string' && search.trim().length > 0;
    const normalizedSearch = rawSearch.length >= PEOPLE_MIN_TEXT_SEARCH_LENGTH ? rawSearch : '';
    const bypassCache = shouldBypassPeopleCache(req);

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

    if (!bypassCache && cacheKey) {
      const cached = await cacheService.get<PeopleResponse>(cacheKey);
      if (cached) {
        res.setHeader('X-Vormex-Cache', 'HIT');
        res.status(200).json(cached);
        return;
      }
    }

    const where: any = {
      isBanned: false,
    };

    if (userId) {
      where.id = { not: userId };
    }

    if (normalizedSearch) {
      where.OR = [
        { name: { contains: normalizedSearch, mode: 'insensitive' } },
        { username: { contains: normalizedSearch, mode: 'insensitive' } },
        { headline: { contains: normalizedSearch, mode: 'insensitive' } },
        { bio: { contains: normalizedSearch, mode: 'insensitive' } },
        { college: { contains: normalizedSearch, mode: 'insensitive' } },
        { branch: { contains: normalizedSearch, mode: 'insensitive' } },
        {
          skills: {
            some: {
              skill: {
                name: { contains: normalizedSearch, mode: 'insensitive' },
              },
            },
          },
        },
        { interests: { hasSome: interestSearchVariants(normalizedSearch) } },
      ];
    }

    const normalizedCollege = normalizeSearchText(college, 120);
    if (normalizedCollege) {
      where.college = normalizedCollege;
    }

    const normalizedBranch = normalizeSearchText(branch, 120);
    if (normalizedBranch) {
      where.branch = normalizedBranch;
    }

    const parsedGraduationYear = parseInt(String(graduationYear ?? ''), 10);
    if (Number.isFinite(parsedGraduationYear)) {
      where.graduationYear = parsedGraduationYear;
    }

    const skillList = splitQueryList(skills).map((s) => s.toLowerCase());
    if (skillList.length > 0) {
      where.skills = {
        some: {
          skill: {
            name: { in: skillList, mode: 'insensitive' },
          },
        },
      };
    }

    const interestList = splitQueryList(interests);
    if (interestList.length > 0) {
      where.interests = { hasSome: interestList };
    }

    const normalizedLocation = normalizeSearchText(location, 120);
    if (normalizedLocation) {
      where.location = { contains: normalizedLocation, mode: 'insensitive' };
    }

    if (isOpenToOpportunities === 'true') {
      where.isOpenToOpportunities = true;
    }

    const findWhere = cursorWhere ? { AND: [where, cursorWhere] } : where;
    const shouldFetchExtra = Boolean(cursor) || !includeTotal;
    const requestedTake = shouldFetchExtra ? limit + 1 : limit;

    const [fetchedUsers, countedTotal] = await Promise.all([
      prismaRead.user.findMany({
        where: findWhere,
        skip: cursor ? 0 : skip,
        take: requestedTake,
        orderBy: peopleOrderBy,
        select: personCardUserSelectWithCursor,
      }),
      includeTotal ? prismaRead.user.count({ where }) : Promise.resolve(null),
    ]);

    const hasExtraUser = shouldFetchExtra && fetchedUsers.length > limit;
    const users = hasExtraUser ? fetchedUsers.slice(0, limit) : fetchedUsers;
    const relationship = await getRelationshipSummary(
      userId,
      users.map((user) => user.id),
      includeMutualConnections
    );
    const people: PersonCard[] = users.map((user) => mapUserToPersonCard(user, relationship));

    const total = countedTotal ?? (skip + people.length + (hasExtraUser ? 1 : 0));
    const totalPages = includeTotal
      ? Math.max(1, Math.ceil(total / limit))
      : (hasExtraUser ? page + 1 : page);
    const hasMore = shouldFetchExtra ? hasExtraUser : page < totalPages;
    const response: PeopleResponse = {
      people,
      total,
      page,
      totalPages,
      hasMore,
      nextCursor: hasMore && users.length > 0 ? encodePeopleCursor(users[users.length - 1]) : null,
    };

    if (!bypassCache && cacheKey) {
      await cacheService.set(
        cacheKey,
        response,
        userId ? PEOPLE_AUTH_CACHE_TTL_SECONDS : PEOPLE_PUBLIC_CACHE_TTL_SECONDS,
        peopleCacheTags(userId)
      );
    }

    res.setHeader('X-Vormex-Cache', bypassCache ? 'BYPASS' : 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching people:', error);
    res.status(500).json({
      error: 'Failed to fetch people',
    });
  }
};

/**
 * Get personalized suggestions
 * GET /api/people/suggestions
 */
export const getSuggestions = async (
  req: AuthenticatedRequest,
  res: Response<{ suggestions: PersonCard[]; total?: number; hasMore?: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);
    const cacheKey = peopleSuggestionsCacheKey(userId, limit);
    const cached = await cacheService.get<{ suggestions: PersonCard[]; total?: number; hasMore?: boolean }>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
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

    const suggestionSignals: any[] = [];
    if (currentUser.college) suggestionSignals.push({ college: currentUser.college });
    if (currentUser.branch) suggestionSignals.push({ branch: currentUser.branch });
    if (currentUser.interests.length > 0) {
      suggestionSignals.push({ interests: { hasSome: currentUser.interests } });
    }
    if (currentUser.graduationYear) suggestionSignals.push({ graduationYear: currentUser.graduationYear });

    const candidateTake = Math.min(
      Math.max(limit * PEOPLE_SUGGESTION_POOL_MULTIPLIER, limit + 10),
      PEOPLE_SUGGESTION_POOL_MAX
    );
    const users = await prismaRead.user.findMany({
      where: {
        id: { not: userId },
        isBanned: false,
        ...(suggestionSignals.length > 0 ? { OR: suggestionSignals } : {}),
      },
      take: candidateTake,
      orderBy: peopleOrderBy,
      select: personCardUserSelect,
    });

    const relationship = await getRelationshipSummary(userId, users.map((user) => user.id));
    const suggestions: PersonCard[] = users
      .filter((user) => !relationship.connectionStatusByUser.has(user.id))
      .slice(0, limit)
      .map((user) => mapUserToPersonCard(user, relationship));
    const response = { suggestions, total: suggestions.length, hasMore: false };

    await cacheService.set(
      cacheKey,
      response,
      PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS,
      peopleCacheTags(userId)
    );

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.status(200).json(response);
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
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);
    const cacheKey = peopleSameCollegeCacheKey(userId, limit);
    const cached = await cacheService.get<{
      people: PersonCard[];
      userCollege?: string | null;
      total?: number;
      page?: number;
      totalPages?: number;
      hasMore?: boolean;
    }>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
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
        id: { not: userId },
        isBanned: false,
        college: currentUser.college,
      },
      take: limit,
      orderBy: peopleOrderBy,
      select: personCardUserSelect,
    });

    const relationship = await getRelationshipSummary(userId, users.map((user) => user.id));
    const people: PersonCard[] = users.map((user) => mapUserToPersonCard(user, relationship));

    const response = {
      people,
      userCollege: currentUser.college,
      total: people.length,
      page: 1,
      totalPages: 1,
      hasMore: false,
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
 * Search colleges on the platform
 * GET /api/people/colleges?q=search_term
 * Returns unique college names from all users
 */
export const searchColleges = async (
  req: AuthenticatedRequest,
  res: Response<{ colleges: { name: string; count: number }[] } | ErrorResponse>
): Promise<void> => {
  try {
    const query = normalizeSearchText(req.query.q, 80);
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);
    if (query.length > 0 && query.length < PEOPLE_MIN_TEXT_SEARCH_LENGTH) {
      res.status(200).json({ colleges: [] });
      return;
    }

    const cacheKey = peopleCollegesCacheKey(query.toLowerCase(), limit);
    const cached = await cacheService.get<{ colleges: { name: string; count: number }[] }>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
      return;
    }

    const collegeData = await prismaRead.user.groupBy({
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
    });

    const colleges = collegeData
      .filter((c) => c.college !== null)
      .map((c) => ({
        name: c.college!,
        count: c._count.college,
      }));

    const response = { colleges };
    await cacheService.set(
      cacheKey,
      response,
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
    const cached = await cacheService.get<{ people: PersonCard[] }>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.status(200).json(cached);
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
        id: { not: userId },
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

    const relationship = await getRelationshipSummary(userId, users.map((user) => user.id));
    const people: PersonCard[] = users.map((user) => mapUserToPersonCard(user, relationship));

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
        by: ['location'],
        where: { isBanned: false, location: { not: null } },
        _count: { location: true },
        orderBy: { _count: { location: 'desc' } },
        take: PEOPLE_FILTER_OPTION_LIMIT,
      }),
    ]);

    const response = {
      colleges: collegesResult.map((c) => c.college!).filter(Boolean).sort(),
      branches: branchesResult.map((b) => b.branch!).filter(Boolean).sort(),
      graduationYears: yearsResult.map((y) => y.graduationYear!).filter(Boolean),
      locations: locationsResult.map((l) => l.location!).filter(Boolean).sort(),
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
