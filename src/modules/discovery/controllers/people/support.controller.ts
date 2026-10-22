import { CoarseLocationDTO, serializeCoarseLocation } from "../../../profiles/utils/location-dto.util";
import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { recordPeopleSearchAppearances } from "../../services/discovery-power.service";
import { encodeKeysetCursor, decodeKeysetCursor, nullableDateDescIdAscWhere } from "../../../../shared/utils/keyset-pagination.util";
import { createHash } from "crypto";
import { CollegeSuggestion } from "../../../education/services/college-catalog.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prismaRead } from "../../../../config/prisma";
import { getPeopleRelationshipCapabilities } from "../../../connections/services/people-relationship.service";
import { type PremiumVisibilityState, applyPremiumVisibilityToUser } from "../../../premium/services/premium-visibility.service";

export interface PersonCard {
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

export interface PeopleResponse {
  people: PersonCard[];
  total: number;
  page: number;
  totalPages: number;
  hasMore: boolean;
  nextCursor?: string | null;
  totalIsApproximate?: boolean;
}

export interface SuggestionQuota {
  isPremium: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  window: 'day';
  resetsAt: string | null;
}

export interface FilterOptions {
  colleges: string[];
  branches: string[];
  graduationYears: number[];
  locations: string[];
}

export const PEOPLE_CACHE_VERSION = 'v6';

export const PEOPLE_GLOBAL_CACHE_TAG = 'people:global';

export const PEOPLE_PUBLIC_CACHE_TTL_SECONDS = 15;

export const PEOPLE_AUTH_CACHE_TTL_SECONDS = 30;

export const PEOPLE_PERSONALIZED_CACHE_TTL_SECONDS = 60;

export const PEOPLE_FILTER_OPTIONS_CACHE_KEY = 'people:filter-options:v2';

export const PEOPLE_FILTER_OPTIONS_CACHE_TTL_SECONDS = 5 * 60;

export const PEOPLE_ACCEPTED_CONNECTION_IDS_CACHE_TTL_SECONDS = 30;

export const PEOPLE_FILTER_OPTION_LIMIT = 100;

export const PEOPLE_BROWSE_DEFAULT_LIMIT = 30;

export const PEOPLE_SEARCH_DEFAULT_LIMIT = 20;

export const PEOPLE_SEARCH_MAX_LIMIT = 30;

export const PEOPLE_MAX_LIMIT = 50;

export const PEOPLE_PERSONALIZED_MAX_LIMIT = 50;

export const PEOPLE_MAX_PERSON_CARD_SKILLS = 8;

export const PEOPLE_MAX_ACCEPTED_CONNECTION_IDS = 1_000;

export const PEOPLE_MAX_MUTUAL_CONNECTION_SCAN_IDS = 500;

export const PEOPLE_MIN_TEXT_SEARCH_LENGTH = 2;

export const PEOPLE_COLLEGE_SEARCH_CACHE_TTL_SECONDS = 5 * 60;

export const PEOPLE_NEAR_ME_CACHE_TTL_SECONDS = 60;

export const PEOPLE_LIST_CACHE_QUERY_KEYS = new Set([
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

export const PEOPLE_SEARCH_APPEARANCE_QUERY_KEYS = new Set([
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

export type PeopleCursor = {
  id: string;
  lastActiveAt: string | null;
};

export type RelationshipSummary = {
  connectionStatusByUser: Map<string, PersonCard['connectionStatus']>;
  connectionIdByUser: Map<string, string>;
  mutualConnectionsByUser: Map<string, number>;
};

export type PeopleSearchRankRow = {
  id: string;
  rank: number;
  lastActiveAt: Date | null;
};

export const emptyRelationshipSummary = (): RelationshipSummary => ({
  connectionStatusByUser: new Map<string, PersonCard['connectionStatus']>(),
  connectionIdByUser: new Map<string, string>(),
  mutualConnectionsByUser: new Map<string, number>(),
});

export const normalizeSearchText = (value: unknown, maxLength = 80): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

export const parseBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = parseInt(String(value ?? ''), 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, normalized));
};

export const shouldBypassPeopleCache = (req: AuthenticatedRequest): boolean => {
  const cacheControl = String(req.headers['cache-control'] || '').toLowerCase();
  return (
    cacheControl.includes('no-cache') ||
    Boolean(normalizeSearchText(req.query.cacheBust, 40)) ||
    Boolean(normalizeSearchText(req.query._t, 40))
  );
};

export const shouldRecordPeopleSearchAppearances = (
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

export const recordPeopleSearchAppearancesIfNeeded = async (
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

export const encodePeopleCursor = (user: { id: string; lastActiveAt?: Date | string | null }): string => {
  return encodeKeysetCursor({
    scope: 'people.discovery',
    id: user.id,
    t: user.lastActiveAt
      ? new Date(user.lastActiveAt).toISOString()
      : null,
  });
};

export const decodePeopleCursor = (value: unknown): PeopleCursor | null => {
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

export const buildCursorWhere = (cursor: PeopleCursor | null): any | null => {
  return nullableDateDescIdAscWhere(
    cursor ? { id: cursor.id, t: cursor.lastActiveAt, scope: 'people.discovery' } : null,
    'lastActiveAt'
  );
};

export const peopleOrderBy: any[] = [
  { lastActiveAt: { sort: 'desc', nulls: 'last' } },
  { id: 'asc' },
];

export const normalizeQueryValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map(String).sort().join(',').slice(0, 160);
  }
  return String(value ?? '').slice(0, 160);
};

export const serializeQuery = (query: AuthenticatedRequest['query']): string =>
  Object.entries(query)
    .filter(([key]) => PEOPLE_LIST_CACHE_QUERY_KEYS.has(key))
    .map(([key, value]) => [key, normalizeQueryValue(value)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

export const buildPeopleListCacheKey = (
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

export const getAcceptedConnectionIdsCacheKey = (userId: string): string =>
  `people:accepted-connections:${userId}`;

export const peopleCollegesCacheKey = (query: string, limit: number): string =>
  `people:colleges:${PEOPLE_CACHE_VERSION}:q:${createHash('sha256').update(query).digest('hex').slice(0, 24)}:limit:${limit}`;

export const peopleCollegeLogoProxyUrl = (req: AuthenticatedRequest, domain?: string | null): string | null => {
  const normalizedDomain = normalizeSearchText(domain, 120).toLowerCase();
  if (!normalizedDomain) return null;
  const forwardedProto = normalizeSearchText(req.headers['x-forwarded-proto'], 20).split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = req.get('host');
  if (!host) return null;
  return `${protocol}://${host}${req.baseUrl}/college-logo?domain=${encodeURIComponent(normalizedDomain)}`;
};

export const withCollegeLogoProxyUrls = (
  req: AuthenticatedRequest,
  colleges: CollegeSuggestion[]
): CollegeSuggestion[] =>
  colleges.map((college) => ({
    ...college,
    logoUrl: peopleCollegeLogoProxyUrl(req, college.domain) || college.logoUrl,
  }));

export const peopleNearMeCacheKey = (userId: string, limit: number): string =>
  `people:near-me:${PEOPLE_CACHE_VERSION}:user:${userId}:limit:${limit}`;

export const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

export const peopleCacheTags = (userId?: string | null): string[] =>
  uniqueCacheTags([
    PEOPLE_GLOBAL_CACHE_TAG,
    userId ? `people:user:${userId}` : 'people:public',
    userId ? `people:connections:${userId}` : '',
  ]);

export const peopleSameCollegeCacheKey = (userId: string, page: number, limit: number): string =>
  `people:same-college:${PEOPLE_CACHE_VERSION}:user:${userId}:page:${page}:limit:${limit}`;

export const filterBlockedPeople = <T extends { id: string }>(people: T[], blockedUserIds: string[]): T[] => {
  if (blockedUserIds.length === 0) return people;
  const blockedSet = new Set(blockedUserIds);
  return people.filter((person) => !blockedSet.has(person.id));
};

export const personCardUserSelect = {
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
  shareLocationPublic: true,
  interests: true,
  isOnline: true,
  isVerified: true,
  profileBadgeStyle: true,
  skills: {
    take: PEOPLE_MAX_PERSON_CARD_SKILLS,
    select: { skill: { select: { name: true } } },
  },
};

export const personCardUserSelectWithCursor = {
  ...personCardUserSelect,
  lastActiveAt: true,
};

export const getAcceptedConnectionIds = async (userId: string): Promise<string[]> => {
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

export const getRelationshipSummary = async (
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

export const peopleSearchScope = (query: string): string =>
  `people.search.${createHash('sha256').update(query).digest('hex').slice(0, 20)}`;

export const decodePeopleSearchCursor = (value: unknown, query: string) =>
  decodeKeysetCursor(value, peopleSearchScope(query));

export const encodePeopleSearchCursor = (row: PeopleSearchRankRow, query: string): string =>
  encodeKeysetCursor({
    scope: peopleSearchScope(query),
    id: row.id,
    n: Number(row.rank),
    t: row.lastActiveAt?.toISOString() ?? null,
  });

export const mapUserToPersonCard = (
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
    location: visibleUser.shareLocationPublic === true
      ? serializeCoarseLocation(visibleUser)
      : null,
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
