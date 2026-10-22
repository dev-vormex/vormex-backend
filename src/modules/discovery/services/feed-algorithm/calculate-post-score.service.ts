import { getPostMetadata } from "../../../content/utils/post.util";
import { NormalizedFeedContext, toNumber, FeedRecommendationContext, normalizeContext, postSearchText, postTagTokens, hoursOld, getSavedCount, hasUserLike, hasUserSave, authorEducationScore, affinityScore, exactTagScore, RankedPost, FRESH_UNSEEN_POST_HOURS, MAX_FRESH_UNSEEN_PROMOTIONS, parseCreatedAtMs, RecommendedFeedCursorState, RankedFeedPageResult, RECOMMENDED_FEED_MAX_PAGE_SIZE, decodeRecommendedFeedCursor, encodeRecommendedFeedCursor } from "./recommended-feed-candidate-limit.service";

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

function authorPremiumVisibilityScore(post: any): number {
  const author = post?.author || {};
  let score = 0;
  score += toNumber(author.discoveryPriority) * 35;
  if (author.profileBoostActive) score += 1800;
  if (author.isPremium) score += 700;
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
  score += authorPremiumVisibilityScore(post);
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
