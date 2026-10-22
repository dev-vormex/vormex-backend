import type { CandidateSource } from './feed-config';

/**
 * Shared vocabulary for the feed pipeline.
 *
 * Stages communicate only through these shapes, so a stage can be swapped
 * (heuristic ranker → learned ranker, SQL pools → precomputed pools) without any
 * other stage changing.
 */

/** Cheap row produced by candidate generation. Never carries post bodies. */
export interface FeedCandidateRef {
  postId: string;
  authorId: string;
  createdAt: Date;
  source: CandidateSource;
  /** Optional per-source hint, e.g. trending velocity or cohort engager count. */
  sourceScore?: number;
}

/** A deduplicated candidate: one post, every pool that produced it. */
export interface FeedCandidate {
  postId: string;
  authorId: string;
  createdAt: Date;
  sources: Set<CandidateSource>;
  sourceScores: Partial<Record<CandidateSource, number>>;
}

/** Minimal post row loaded for scoring. Full hydration happens after ranking. */
export interface FeedScoringPost {
  id: string;
  authorId: string;
  content: string;
  type: string;
  visibility: string;
  mediaUrls: string[];
  metadata: unknown;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedAuthorProfile {
  id: string;
  college: string | null;
  branch: string | null;
  degree: string | null;
  graduationYear: number | null;
  interests: string[];
  isBanned: boolean;
  createdAt: Date;
  followersCount: number;
  isPremium: boolean;
  profileBoostActive: boolean;
}

/** Everything about the viewer that ranking needs, loaded once per request. */
export interface FeedViewerContext {
  userId: string;
  college: string | null;
  branch: string | null;
  degree: string | null;
  graduationYear: number | null;
  interestTokens: string[];
  skillTokens: string[];
  educationTokens: string[];
  followingIds: string[];
  connectionIds: string[];
  recentConnectionIds: string[];
  mutualFollowIds: string[];
  secondDegreeIds: string[];
  /** Creators the viewer has liked/commented/saved recently → 0..1 affinity. */
  creatorAffinity: Record<string, number>;
  /** Recently viewed profiles → 0..1 affinity. */
  profileVisitAffinity: Record<string, number>;
  /** Message volume per peer, used by the relationship scorer. */
  messageCounts: Record<string, number>;
  /** Total positive interactions the viewer has produced. Drives cold-start. */
  interactionCount: number;
  isColdStart: boolean;
}

/** Everything needed to exclude a post before it is ever scored. */
export interface FeedEligibilityContext {
  blockedUserIds: Set<string>;
  hiddenAuthorIds: Set<string>;
  notInterestedPostIds: Set<string>;
  bannedAuthorIds: Set<string>;
  ownPostIds: Set<string>;
  /** Posts whose negative-feedback rate proved them harmful at scale. */
  suppressedPostIds: Set<string>;
}

export interface FeedSeenRecord {
  seenAt: Date;
  seenCount: number;
  dwellMs: number | null;
}

/** Per-creator behavioural evidence derived from this viewer's own impressions. */
export interface FeedCreatorBehaviour {
  impressions: number;
  engagements: number;
  averageDwellMs: number;
  skipRatio: number;
}

export interface FeedPostStats {
  impressions: number;
  positives: number;
  negatives: number;
  uniqueEngagers: number;
  /** Weighted engagement inside the rolling velocity window. */
  recentEngagement: number;
}

/** The full signal vector for one candidate. All values are 0..1 unless noted. */
export interface FeedSignals {
  isFollowing: boolean;
  isConnection: boolean;
  isRecentConnection: boolean;
  isMutualFollow: boolean;
  isSecondDegree: boolean;
  relationshipStrength: number;

  sameCollege: boolean;
  sameCourse: boolean;
  sameYear: boolean;
  sharedInterests: number;
  sharedSkills: number;

  creatorAffinity: number;
  contentAffinity: number;
  cohortProof: number;

  freshness: number;
  ageHours: number;
  engagementQuality: number;
  engagementVelocity: number;
  contentCompleteness: number;
  premiumTieBreak: number;

  isNewPost: boolean;
  isNewCreator: boolean;
  explorationEligible: boolean;

  seenAt: Date | null;
  seenCount: number;
  lowDwell: boolean;
  creatorSkipped: boolean;
  negativeFeedbackRate: number;
  authorBurst: boolean;
}

export interface FeedScoreBreakdown {
  [component: string]: number;
}

export interface ScoredFeedCandidate {
  postId: string;
  authorId: string;
  post: FeedScoringPost;
  sources: CandidateSource[];
  primarySource: CandidateSource;
  signals: FeedSignals;
  baseScore: number;
  breakdown: FeedScoreBreakdown;
  isExploration: boolean;
  topics: string[];
  college: string | null;
}

export interface RerankedFeedItem extends ScoredFeedCandidate {
  position: number;
  finalScore: number;
  diversityAdjustment: number;
  reasonCode: string;
  reasonText: string;
}

export interface FeedPipelineResult {
  items: RerankedFeedItem[];
  rankingVersion: string;
  candidateCount: number;
  eligibleCount: number;
  sourceCounts: Record<string, number>;
  explorationShare: number;
  coldStart: boolean;
  degraded: boolean;
}

/** Developer-only explain payload. Gated by `isFeedDebugAllowed()`. */
export interface FeedDebugEntry {
  postId: string;
  authorId: string;
  position: number;
  finalScore: number;
  baseScore: number;
  diversityAdjustment: number;
  primarySource: CandidateSource;
  candidateSources: CandidateSource[];
  breakdown: FeedScoreBreakdown;
  signals: FeedSignals;
}
