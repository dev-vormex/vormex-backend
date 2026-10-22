/**
 * Public surface of the personalized home feed (feed-v2).
 *
 * Callers should import from here rather than reaching into individual stages,
 * so a stage can be replaced without touching call sites.
 */

export {
  FEED_RANKING_VERSION,
  DEFAULT_FEED_CONFIG,
  EXPLORATION_SOURCES,
  SOURCE_PRIORITY,
  SOURCE_REASON,
  getFeedConfig,
  isFeedDebugAllowed,
  resetFeedConfigCache,
  type CandidateSource,
  type FeedConfig,
} from './feed-config';

export type {
  FeedCandidate,
  FeedCandidateRef,
  FeedDebugEntry,
  FeedPipelineResult,
  FeedScoreBreakdown,
  FeedSignals,
  FeedViewerContext,
  RerankedFeedItem,
  ScoredFeedCandidate,
} from './feed-types';

export {
  buildPersonalizedFeed,
  buildFeedDebugEntries,
  isFeedV2Enabled,
  type BuildFeedOutput,
} from './feed-pipeline.service';

export {
  loadFeedViewerContext,
  invalidateFeedViewerContext,
  emptyViewerContext,
} from './feed-viewer-context.service';

export {
  loadEligibilityContext,
  filterEligibleCandidates,
  excludedAuthorIds,
} from './feed-eligibility.service';

export { generateCandidates, mergeCandidates, CANDIDATE_GENERATORS } from './candidate-generators';

export { rankCandidate, sortScoredCandidates, seenPenalty, primarySourceOf, isExplorationCandidate } from './feed-ranker';

export { rerankFeed, diversityAdjustment, explorationShare, explorationTarget } from './feed-reranker';

export {
  relationshipStrength,
  scoreRelationship,
  saturate,
  sharedRatio,
  decayedCount,
  type RelationshipInput,
} from './relationship-scorer.service';

export {
  engagementQuality,
  engagementVelocity,
  weightedEngagement,
  weightedEngagementRate,
  effectiveReach,
  trendingScore,
} from './engagement-scorer.service';

export {
  normalizeImpressionPayload,
  recordFeedImpressions as writeFeedImpressions,
  backfillImpressionCreatorIds,
  MAX_IMPRESSION_BATCH,
  MIN_QUALIFYING_VISIBLE_MS,
} from './feed-impression.service';

export { computeSignals, loadSignalInputs, freshness, postSearchText, postTopics } from './feed-signals.service';
