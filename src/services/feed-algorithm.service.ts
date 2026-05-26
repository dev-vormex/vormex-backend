import { getPostMetadata } from '../utils/post.util';

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

interface NormalizedFeedContext {
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

interface RankedPost {
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
const RECOMMENDED_FEED_MAX_PAGE_SIZE = 50;
const MAX_RECOMMENDED_CURSOR_OFFSET = 1_000_000;
const FRESH_UNSEEN_POST_HOURS = 12;
const MAX_FRESH_UNSEEN_PROMOTIONS = 3;

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

function toNumber(value: unknown): number {
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

function normalizeContext(contextOrSeenPostIds?: FeedRecommendationContext | string[]): NormalizedFeedContext {
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

function getSavedCount(post: any): number {
  if (post?.savesCount !== undefined) {
    return toNumber(post.savesCount);
  }

  if (post?._count?.saved_posts !== undefined) {
    return toNumber(post._count.saved_posts);
  }

  return Array.isArray(post?.saved_posts) ? post.saved_posts.length : 0;
}

function hasUserLike(post: any, currentUserId: string | null): boolean {
  if (typeof post?.isLiked === 'boolean') return post.isLiked;
  if (!currentUserId || !Array.isArray(post?.likes)) return false;
  return post.likes.some((like: any) => String(like?.userId || '') === currentUserId);
}

function hasUserSave(post: any, currentUserId: string | null): boolean {
  if (typeof post?.isSaved === 'boolean') return post.isSaved;
  if (!currentUserId || !Array.isArray(post?.saved_posts)) return false;
  return post.saved_posts.some((saved: any) => String(saved?.userId || '') === currentUserId);
}

function parseCreatedAtMs(createdAt: unknown, fallbackMs: number): number {
  const parsed = new Date(createdAt as any).getTime();
  if (Number.isFinite(parsed)) return parsed;
  return fallbackMs;
}

function hoursOld(createdAt: unknown, nowMs: number): number {
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

function postSearchText(post: any): string {
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

function postTagTokens(post: any): Set<string> {
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

function affinityScore(text: string, weights: TokenWeights, perWeight: number, cap: number): number {
  if (!text || Object.keys(weights).length === 0) return 0;

  const score = Object.entries(weights).reduce((sum, [token, weight]) => {
    return containsToken(text, token) ? sum + weight * perWeight : sum;
  }, 0);

  return Math.min(score, cap);
}

function exactTagScore(tags: Set<string>, weights: TokenWeights, perWeight: number, cap: number): number {
  if (tags.size === 0 || Object.keys(weights).length === 0) return 0;

  let score = 0;
  for (const token of tags) {
    score += (weights[token] || 0) * perWeight;
  }

  return Math.min(score, cap);
}

function authorEducationScore(post: any, context: NormalizedFeedContext): number {
  let score = 0;
  const authorCollege = normalizeToken(post?.author?.college);
  const authorBranch = normalizeToken(post?.author?.branch);
  const authorDegree = normalizeToken(post?.author?.degree);

  if (authorCollege && context.educationWeights[authorCollege]) score += 900;
  if (authorBranch && context.educationWeights[authorBranch]) score += 520;
  if (authorDegree && context.educationWeights[authorDegree]) score += 320;

  return score;
}

function relationshipScore(post: any, context: NormalizedFeedContext): number {
  let score = 0;
  const authorId = String(post?.authorId || post?.author?.id || '').trim();
  if (!authorId) return score;

  if (authorId === context.currentUserId) score += 900;
  if (context.followingAuthorIds.has(authorId)) score += 2600;
  if (context.connectionAuthorIds.has(authorId)) score += 2050;
  score += (context.recentProfileWeights[authorId] || 0) * 240;

  if (String(post?.visibility || '').toLowerCase() === 'connections') {
    score += 260;
  }

  return score;
}

function contentCompletenessScore(post: any): number {
  const metadata = getPostMetadata(post?.metadata);
  const mediaUrls = Array.isArray(post?.mediaUrls) ? post.mediaUrls.filter(Boolean) : [];
  const normalizedType = String(post?.type || '').toLowerCase();

  let score = 0;
  if (String(post?.content || '').trim()) score += 90;
  if (mediaUrls.length > 0) score += 120;
  if (metadata.videoUrl || metadata.defaultVideoId || normalizedType === 'video') score += 150;
  if (metadata.documentUrl || normalizedType === 'document') score += 130;
  if (metadata.linkUrl || normalizedType === 'link') score += 80;
  if ((metadata.pollOptions || []).length > 0 || normalizedType === 'poll') score += 110;
  if (metadata.articleTitle || normalizedType === 'article') score += 120;
  return score;
}

function stableExplorationBoost(id: unknown): number {
  const value = String(id || '');
  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }

  return Math.abs(hash % 97);
}

function seenPenalty(post: any, context: NormalizedFeedContext): number {
  const postId = String(post?.id || '');
  if (!postId || !context.seenPostIds.has(postId)) return 1;

  const seenAt = context.seenAtByPostId.get(postId);
  const seenAtMs = seenAt ? new Date(seenAt as any).getTime() : NaN;

  if (!Number.isFinite(seenAtMs)) return 0.35;

  const hoursSinceSeen = Math.max(0, context.nowMs - seenAtMs) / (1000 * 60 * 60);
  if (hoursSinceSeen <= 1) return 0.12;
  if (hoursSinceSeen <= 6) return 0.2;
  if (hoursSinceSeen <= 24) return 0.35;
  if (hoursSinceSeen <= 72) return 0.55;
  return 0.75;
}

export function calculatePostScore(
  post: any,
  contextOrSeenPostIds: FeedRecommendationContext | string[] = []
): number {
  const context = normalizeContext(contextOrSeenPostIds);
  const searchText = postSearchText(post);
  const tagTokens = postTagTokens(post);
  const recencyScore = Math.exp(-0.035 * hoursOld(post?.createdAt, context.nowMs)) * 1350;
  const engagement =
    toNumber(post?.likesCount) +
    toNumber(post?.commentsCount) * 3 +
    toNumber(post?.sharesCount) * 5 +
    getSavedCount(post) * 4;

  let score = recencyScore;
  score += Math.min(engagement * 18, 1900);
  score += hasUserLike(post, context.currentUserId) ? 360 : 0;
  score += hasUserSave(post, context.currentUserId) ? 520 : 0;
  score += relationshipScore(post, context);
  score += authorEducationScore(post, context);
  score += affinityScore(searchText, context.skillWeights, 1180, 4720);
  score += affinityScore(searchText, context.interestWeights, 860, 3440);
  score += affinityScore(searchText, context.educationWeights, 700, 2800);
  score += exactTagScore(tagTokens, context.skillWeights, 1360, 4080);
  score += exactTagScore(tagTokens, context.interestWeights, 920, 2760);
  score += exactTagScore(tagTokens, context.educationWeights, 720, 2160);
  score += contentCompletenessScore(post);
  score += stableExplorationBoost(post?.id);

  score *= seenPenalty(post, context);

  return Number.isFinite(score) ? score : 0;
}

function spreadAuthors(posts: RankedPost[]): RankedPost[] {
  const remaining = [...posts];
  const result: RankedPost[] = [];
  const authorCounts = new Map<string, number>();
  let lastAuthorId: string | null = null;

  while (remaining.length > 0) {
    let nextIndex = remaining.findIndex((entry) => {
      const authorId = String(entry.post?.authorId || entry.post?.author?.id || '');
      return authorId !== lastAuthorId && (authorCounts.get(authorId) || 0) < 2;
    });

    if (nextIndex < 0) {
      nextIndex = remaining.findIndex((entry) => {
        const authorId = String(entry.post?.authorId || entry.post?.author?.id || '');
        return authorId !== lastAuthorId;
      });
    }

    if (nextIndex < 0) nextIndex = 0;

    const [next] = remaining.splice(nextIndex, 1);
    result.push(next);

    lastAuthorId = String(next.post?.authorId || next.post?.author?.id || '');
    authorCounts.set(lastAuthorId, (authorCounts.get(lastAuthorId) || 0) + 1);
  }

  return result;
}

function postAuthorId(post: any): string {
  return String(post?.authorId || post?.author?.id || '').trim();
}

function isFreshUnseenPost(post: any, context: NormalizedFeedContext): boolean {
  const postId = String(post?.id || '');
  if (!postId || context.seenPostIds.has(postId)) return false;
  return hoursOld(post?.createdAt, context.nowMs) <= FRESH_UNSEEN_POST_HOURS;
}

function promoteFreshUnseenPosts(posts: any[], context: NormalizedFeedContext, limit: number): any[] {
  if (posts.length <= 1 || limit <= 0) return posts;

  const promotionLimit = Math.min(
    MAX_FRESH_UNSEEN_PROMOTIONS,
    Math.max(1, Math.floor(limit / 4))
  );
  const freshCandidates = posts
    .filter((post) => isFreshUnseenPost(post, context))
    .sort((a, b) => parseCreatedAtMs(b?.createdAt, 0) - parseCreatedAtMs(a?.createdAt, 0));

  if (freshCandidates.length === 0) return posts;

  const promoted: any[] = [];
  const promotedIds = new Set<string>();
  const promotedAuthorIds = new Set<string>();

  for (const post of freshCandidates) {
    const authorId = postAuthorId(post);
    if (authorId && promotedAuthorIds.has(authorId)) continue;

    promoted.push(post);
    promotedIds.add(String(post?.id || ''));
    if (authorId) promotedAuthorIds.add(authorId);

    if (promoted.length >= promotionLimit) break;
  }

  for (const post of freshCandidates) {
    if (promoted.length >= promotionLimit) break;
    const postId = String(post?.id || '');
    if (promotedIds.has(postId)) continue;
    promoted.push(post);
    promotedIds.add(postId);
  }

  if (promoted.length === 0) return posts;

  return [
    ...promoted,
    ...posts.filter((post) => !promotedIds.has(String(post?.id || ''))),
  ];
}

function prioritizeUnseenPosts(posts: any[], context: NormalizedFeedContext): any[] {
  if (context.seenPostIds.size === 0) return posts;

  const unseen: any[] = [];
  const seen: any[] = [];
  for (const post of posts) {
    const postId = String(post?.id || '');
    if (postId && context.seenPostIds.has(postId)) {
      seen.push(post);
    } else {
      unseen.push(post);
    }
  }

  return unseen.length > 0 ? [...unseen, ...seen] : posts;
}

export function rankFeed(
  posts: any[],
  contextOrSeenPostIds: FeedRecommendationContext | string[] = []
): any[] {
  const seenInput = new Set<string>();
  const distinctPosts = posts.filter((post) => {
    const postId = String(post?.id || '');
    if (!postId || seenInput.has(postId)) return false;
    seenInput.add(postId);
    return true;
  });

  const ranked = distinctPosts
    .map((post, index) => ({
      post,
      index,
      createdAtMs: parseCreatedAtMs(post?.createdAt, 0),
      score: calculatePostScore(post, contextOrSeenPostIds),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
      return a.index - b.index;
    });

  return spreadAuthors(ranked).map((entry) => entry.post);
}

export function rankFeedPage(
  posts: any[],
  contextOrSeenPostIds: FeedRecommendationContext | string[] = [],
  options: {
    limit: number;
    cursorState?: RecommendedFeedCursorState;
    hasMoreChronological?: boolean;
    chronologicalBoundaryCursor?: string | null;
  }
): RankedFeedPageResult {
  const limit = Math.min(
    Math.max(Math.floor(toNumber(options.limit) || RECOMMENDED_FEED_MAX_PAGE_SIZE), 1),
    RECOMMENDED_FEED_MAX_PAGE_SIZE
  );
  const cursorState = options.cursorState || decodeRecommendedFeedCursor(null);
  const context = normalizeContext(contextOrSeenPostIds);
  const rankedBase = promoteFreshUnseenPosts(rankFeed(posts, context), context, limit);
  const ranked = cursorState.offset === 0 && !cursorState.baseCursor
    ? prioritizeUnseenPosts(rankedBase, context)
    : rankedBase;
  const startOffset = Math.min(Math.max(cursorState.offset, 0), ranked.length);
  const items = ranked.slice(startOffset, startOffset + limit);
  const nextOffset = startOffset + items.length;

  let nextCursor: string | null = null;
  if (nextOffset < ranked.length) {
    nextCursor = encodeRecommendedFeedCursor(
      cursorState.baseCursor,
      nextOffset,
      cursorState.sessionStartedAtMs
    );
  } else if (options.hasMoreChronological && options.chronologicalBoundaryCursor) {
    nextCursor = encodeRecommendedFeedCursor(
      options.chronologicalBoundaryCursor,
      0,
      cursorState.sessionStartedAtMs
    );
  }

  return {
    items,
    nextCursor,
    hasMore: Boolean(nextCursor),
    rankedCandidateCount: ranked.length,
  };
}
