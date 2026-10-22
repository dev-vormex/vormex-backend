import { getPostMetadata } from "../../../content/utils/post.util";

type TokenWeights = Record<string, number>;

type SeenAtLookup = Record<string, Date | string | number | null | undefined>;

export interface FeedRecommendationProfileInput {
  currentUserId?: string | null;
  skills?: Array<string | null | undefined>;
  interests?: Array<string | null | undefined>;
  educationHints?: Array<string | null | undefined>;
  connectionAuthorIds?: Array<string | null | undefined>;
  followingAuthorIds?: Array<string | null | undefined>;
  recentProfileWeights?: Record<string, number>;
}

export interface FeedRecommendationContext {
  currentUserId?: string | null;
  skillWeights?: TokenWeights;
  interestWeights?: TokenWeights;
  educationWeights?: TokenWeights;
  connectionAuthorIds?: Set<string> | string[];
  followingAuthorIds?: Set<string> | string[];
  recentProfileWeights?: Record<string, number>;
  seenPostIds?: Set<string> | string[];
  seenAtByPostId?: Map<string, Date | string | number | null | undefined> | SeenAtLookup;
  nowMs?: number;
}

export interface NormalizedFeedContext {
  currentUserId: string | null;
  skillWeights: TokenWeights;
  interestWeights: TokenWeights;
  educationWeights: TokenWeights;
  connectionAuthorIds: Set<string>;
  followingAuthorIds: Set<string>;
  recentProfileWeights: Record<string, number>;
  seenPostIds: Set<string>;
  seenAtByPostId: Map<string, Date | string | number | null | undefined>;
  nowMs: number;
}

export interface RankedPost {
  post: any;
  index: number;
  createdAtMs: number;
  score: number;
}

export interface RecommendedFeedCursorState {
  baseCursor: string | null;
  offset: number;
  sessionStartedAtMs: number;
  isRecommendedCursor: boolean;
}

export interface RankedFeedPageResult {
  items: any[];
  nextCursor: string | null;
  hasMore: boolean;
  rankedCandidateCount: number;
}

const RECOMMENDED_CURSOR_PREFIX = 'rec';

const RECOMMENDED_CURSOR_ROOT = 'root';

const RECOMMENDED_FEED_WINDOW_MULTIPLIER = 4;

const RECOMMENDED_FEED_MIN_CANDIDATES = 80;

const RECOMMENDED_FEED_MAX_CANDIDATES = 200;

export const RECOMMENDED_FEED_MAX_PAGE_SIZE = 50;

const MAX_RECOMMENDED_CURSOR_OFFSET = 1_000_000;

export const FRESH_UNSEEN_POST_HOURS = 12;

export const MAX_FRESH_UNSEEN_PROMOTIONS = 3;

function safeCursorPart(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9@._:-]{1,160}$/.test(normalized) ? normalized : null;
}

export function recommendedFeedCandidateLimit(limit: number): number {
  const boundedLimit = Math.min(
    Math.max(Math.floor(toNumber(limit) || RECOMMENDED_FEED_MAX_PAGE_SIZE), 1),
    RECOMMENDED_FEED_MAX_PAGE_SIZE
  );
  return Math.min(
    Math.max(boundedLimit * RECOMMENDED_FEED_WINDOW_MULTIPLIER, RECOMMENDED_FEED_MIN_CANDIDATES),
    RECOMMENDED_FEED_MAX_CANDIDATES
  );
}

export function decodeRecommendedFeedCursor(
  cursor?: string | null,
  nowMs: number = Date.now()
): RecommendedFeedCursorState {
  const raw = safeCursorPart(cursor);
  if (!raw) {
    return {
      baseCursor: null,
      offset: 0,
      sessionStartedAtMs: nowMs,
      isRecommendedCursor: false,
    };
  }

  const parts = raw.split(':');
  if (parts.length === 4 && parts[0] === RECOMMENDED_CURSOR_PREFIX) {
    const parsedOffset = Number.parseInt(parts[2], 10);
    const parsedSessionMs = Number.parseInt(parts[3], 36);
    return {
      baseCursor: parts[1] === RECOMMENDED_CURSOR_ROOT ? null : safeCursorPart(parts[1]),
      offset: Number.isFinite(parsedOffset)
        ? Math.min(Math.max(parsedOffset, 0), MAX_RECOMMENDED_CURSOR_OFFSET)
        : 0,
      sessionStartedAtMs: Number.isFinite(parsedSessionMs) && parsedSessionMs > 0
        ? parsedSessionMs
        : nowMs,
      isRecommendedCursor: true,
    };
  }

  return {
    baseCursor: raw,
    offset: 0,
    sessionStartedAtMs: nowMs,
    isRecommendedCursor: false,
  };
}

export function encodeRecommendedFeedCursor(
  baseCursor: string | null,
  offset: number,
  sessionStartedAtMs: number
): string {
  const normalizedBaseCursor = safeCursorPart(baseCursor) || RECOMMENDED_CURSOR_ROOT;
  const normalizedOffset = Math.min(Math.max(Math.floor(toNumber(offset)), 0), MAX_RECOMMENDED_CURSOR_OFFSET);
  const normalizedSessionMs = Math.max(1, Math.floor(toNumber(sessionStartedAtMs) || Date.now()));
  return `${RECOMMENDED_CURSOR_PREFIX}:${normalizedBaseCursor}:${normalizedOffset}:${normalizedSessionMs.toString(36)}`;
}

export function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeToken(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : null;
}

function tokenWeights(values: Array<string | null | undefined> = [], baseWeight: number): TokenWeights {
  const weights: TokenWeights = {};

  for (const value of values) {
    const token = normalizeToken(value);
    if (!token) continue;
    weights[token] = Math.min((weights[token] || 0) + baseWeight, 8);
  }

  return weights;
}

function asStringSet(value?: Set<string> | string[]): Set<string> {
  if (!value) return new Set();
  const values = value instanceof Set ? Array.from(value) : value;
  return new Set(values.map((item) => String(item || '').trim()).filter(Boolean));
}

function asSeenAtMap(
  value?: Map<string, Date | string | number | null | undefined> | SeenAtLookup
): Map<string, Date | string | number | null | undefined> {
  if (!value) return new Map();
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}

export function normalizeContext(contextOrSeenPostIds?: FeedRecommendationContext | string[]): NormalizedFeedContext {
  const context: FeedRecommendationContext = Array.isArray(contextOrSeenPostIds)
    ? { seenPostIds: contextOrSeenPostIds }
    : (contextOrSeenPostIds || {});

  return {
    currentUserId: context.currentUserId ? String(context.currentUserId) : null,
    skillWeights: context.skillWeights || {},
    interestWeights: context.interestWeights || {},
    educationWeights: context.educationWeights || {},
    connectionAuthorIds: asStringSet(context.connectionAuthorIds),
    followingAuthorIds: asStringSet(context.followingAuthorIds),
    recentProfileWeights: context.recentProfileWeights || {},
    seenPostIds: asStringSet(context.seenPostIds),
    seenAtByPostId: asSeenAtMap(context.seenAtByPostId),
    nowMs: Number.isFinite(context.nowMs) ? Number(context.nowMs) : Date.now(),
  };
}

export function buildFeedRecommendationProfile(
  input: FeedRecommendationProfileInput = {}
): FeedRecommendationContext {
  const recentProfileWeights: Record<string, number> = {};
  for (const [userId, weight] of Object.entries(input.recentProfileWeights || {})) {
    const normalizedUserId = String(userId || '').trim();
    const normalizedWeight = Math.max(0, Math.min(Math.round(toNumber(weight)), 24));
    if (normalizedUserId && normalizedWeight > 0) {
      recentProfileWeights[normalizedUserId] = normalizedWeight;
    }
  }

  return {
    currentUserId: input.currentUserId || null,
    skillWeights: tokenWeights(input.skills || [], 2),
    interestWeights: tokenWeights(input.interests || [], 1),
    educationWeights: tokenWeights(input.educationHints || [], 1),
    connectionAuthorIds: asStringSet(
      (input.connectionAuthorIds || []).map((userId) => String(userId || '').trim()).filter(Boolean)
    ),
    followingAuthorIds: asStringSet(
      (input.followingAuthorIds || []).map((userId) => String(userId || '').trim()).filter(Boolean)
    ),
    recentProfileWeights,
  };
}

export function getSavedCount(post: any): number {
  if (post?.savesCount !== undefined) {
    return toNumber(post.savesCount);
  }

  if (post?._count?.saved_posts !== undefined) {
    return toNumber(post._count.saved_posts);
  }

  return Array.isArray(post?.saved_posts) ? post.saved_posts.length : 0;
}

export function hasUserLike(post: any, currentUserId: string | null): boolean {
  if (typeof post?.isLiked === 'boolean') return post.isLiked;
  if (!currentUserId || !Array.isArray(post?.likes)) return false;
  return post.likes.some((like: any) => String(like?.userId || '') === currentUserId);
}

export function hasUserSave(post: any, currentUserId: string | null): boolean {
  if (typeof post?.isSaved === 'boolean') return post.isSaved;
  if (!currentUserId || !Array.isArray(post?.saved_posts)) return false;
  return post.saved_posts.some((saved: any) => String(saved?.userId || '') === currentUserId);
}

export function parseCreatedAtMs(createdAt: unknown, fallbackMs: number): number {
  const parsed = new Date(createdAt as any).getTime();
  if (Number.isFinite(parsed)) return parsed;
  return fallbackMs;
}

export function hoursOld(createdAt: unknown, nowMs: number): number {
  const createdAtMs = parseCreatedAtMs(createdAt, nowMs);
  return Math.max(0, nowMs - createdAtMs) / (1000 * 60 * 60);
}

function normalizeTextForSearch(values: Array<unknown>): string {
  return values
    .filter((value) => value !== null && value !== undefined)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function postSearchText(post: any): string {
  const metadata = getPostMetadata(post?.metadata);

  return normalizeTextForSearch([
    post?.content,
    post?.type,
    post?.author?.name,
    post?.author?.username,
    post?.author?.headline,
    post?.author?.college,
    post?.author?.branch,
    post?.author?.degree,
    metadata.articleTitle,
    metadata.articleTags,
    metadata.linkTitle,
    metadata.linkDescription,
    metadata.linkDomain,
    metadata.documentName,
    metadata.documentType,
    metadata.celebrationType,
    metadata.celebrationBadge,
  ]);
}

export function postTagTokens(post: any): Set<string> {
  const metadata = getPostMetadata(post?.metadata);
  return new Set((metadata.articleTags || []).map((tag) => normalizeToken(tag)).filter(Boolean) as string[]);
}

function containsToken(text: string, token: string): boolean {
  if (!text || !token) return false;

  if (token.length <= 2) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(text);
  }

  return text.includes(token);
}

export function affinityScore(text: string, weights: TokenWeights, perWeight: number, cap: number): number {
  if (!text || Object.keys(weights).length === 0) return 0;

  const score = Object.entries(weights).reduce((sum, [token, weight]) => {
    return containsToken(text, token) ? sum + weight * perWeight : sum;
  }, 0);

  return Math.min(score, cap);
}

export function exactTagScore(tags: Set<string>, weights: TokenWeights, perWeight: number, cap: number): number {
  if (tags.size === 0 || Object.keys(weights).length === 0) return 0;

  let score = 0;
  for (const token of tags) {
    score += (weights[token] || 0) * perWeight;
  }

  return Math.min(score, cap);
}

export function authorEducationScore(post: any, context: NormalizedFeedContext): number {
  let score = 0;
  const authorCollege = normalizeToken(post?.author?.college);
  const authorBranch = normalizeToken(post?.author?.branch);
  const authorDegree = normalizeToken(post?.author?.degree);

  if (authorCollege && context.educationWeights[authorCollege]) score += 900;
  if (authorBranch && context.educationWeights[authorBranch]) score += 520;
  if (authorDegree && context.educationWeights[authorDegree]) score += 320;

  return score;
}
