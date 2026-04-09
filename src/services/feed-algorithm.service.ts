function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getSavedCount(post: any): number {
  if (post?.savesCount !== undefined) {
    return toNumber(post.savesCount);
  }

  if (post?._count?.saved_posts !== undefined) {
    return toNumber(post._count.saved_posts);
  }

  return 0;
}

/**
 * Scoring formula:
 * recencyScore = Math.exp(-0.05 * hoursOld)
 * engagementScore = (likes + comments*3 + shares*5 + saves*2) / 100
 * seenPenalty = seenPostIds.includes(postId) ? 0.3 : 1.0
 * finalScore = (0.4 * recencyScore + 0.6 * engagementScore) * seenPenalty
 */
export function calculatePostScore(post: any, seenPostIds: string[]): number {
  const createdAt = new Date(post?.createdAt);
  const createdAtMs = createdAt.getTime();
  const nowMs = Date.now();

  const hoursOld = Number.isFinite(createdAtMs) && createdAtMs <= nowMs
    ? (nowMs - createdAtMs) / (1000 * 60 * 60)
    : 0;

  const recencyScore = Math.exp(-0.05 * hoursOld);

  const likesCount = toNumber(post?.likesCount);
  const commentsCount = toNumber(post?.commentsCount);
  const sharesCount = toNumber(post?.sharesCount);
  const savesCount = getSavedCount(post);

  const engagementScore =
    (likesCount + commentsCount * 3 + sharesCount * 5 + savesCount * 2) / 100;

  const seenPenalty = seenPostIds.includes(String(post?.id)) ? 0.3 : 1.0;
  const finalScore = (0.4 * recencyScore + 0.6 * engagementScore) * seenPenalty;

  return Number.isFinite(finalScore) ? finalScore : 0;
}

export function rankFeed(posts: any[], seenPostIds: string[]): any[] {
  return [...posts]
    .map((post, index) => ({
      post,
      index,
      score: calculatePostScore(post, seenPostIds),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      // Secondary tie-breaker: newer post first.
      const bTime = new Date(b.post?.createdAt).getTime();
      const aTime = new Date(a.post?.createdAt).getTime();
      if (bTime !== aTime) return bTime - aTime;

      // Stable fallback.
      return a.index - b.index;
    })
    .map((entry) => entry.post);
}
