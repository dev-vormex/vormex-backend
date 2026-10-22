/** Stable import surface; implementations live in focused responsibility modules. */
export {
  FeedRecommendationProfileInput,
  FeedRecommendationContext,
  RecommendedFeedCursorState,
  RankedFeedPageResult,
  recommendedFeedCandidateLimit,
  decodeRecommendedFeedCursor,
  encodeRecommendedFeedCursor,
  buildFeedRecommendationProfile,
} from './feed-algorithm/recommended-feed-candidate-limit.service';
export { calculatePostScore, rankFeed, rankFeedPage } from './feed-algorithm/calculate-post-score.service';
