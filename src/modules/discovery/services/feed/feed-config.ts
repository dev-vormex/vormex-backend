/**
 * Every tunable number the home feed ranker uses lives here.
 *
 * Nothing in the pipeline is allowed to hardcode a weight, cap, or window: the
 * previous ranker spread magic numbers across its scorer, which made the feed
 * impossible to tune without a deploy and impossible to reason about at all.
 *
 * All values can be overridden at runtime through `FEED_V2_CONFIG_JSON` (a deep
 * partial of `FeedConfig`), so this module is already shaped like a remote-config
 * read even though the source today is the environment. When Vormex grows a real
 * config service, only `loadOverrides()` changes.
 */

export const FEED_RANKING_VERSION = process.env.FEED_V2_RANKING_VERSION || 'feed-v2.0';

export type CandidateSource =
  | 'FOLLOWING'
  | 'CONNECTION'
  | 'RECENT_CONNECTION'
  | 'INTERACTED_CREATOR'
  | 'COLLEGE'
  | 'COURSE'
  | 'INTEREST'
  | 'SKILL'
  | 'SECOND_DEGREE'
  | 'COHORT_POPULAR'
  | 'TRENDING'
  | 'RECENT'
  | 'DISCOVERY'
  | 'NEW_CREATOR';

/** Sources that count as exploration when the re-ranker balances the page. */
export const EXPLORATION_SOURCES: readonly CandidateSource[] = [
  'DISCOVERY',
  'NEW_CREATOR',
  'SECOND_DEGREE',
  'TRENDING',
];

/**
 * Ordering used to pick a single reportable source when a post was produced by
 * several pools. Earliest match wins, so the label always describes the
 * strongest reason the post is in the feed.
 */
export const SOURCE_PRIORITY: readonly CandidateSource[] = [
  'FOLLOWING',
  'RECENT_CONNECTION',
  'CONNECTION',
  'INTERACTED_CREATOR',
  'COLLEGE',
  'COURSE',
  'SKILL',
  'INTEREST',
  'COHORT_POPULAR',
  'SECOND_DEGREE',
  'TRENDING',
  'NEW_CREATOR',
  'DISCOVERY',
  'RECENT',
];

export const SOURCE_REASON: Record<CandidateSource, { code: string; text: string }> = {
  FOLLOWING: { code: 'FROM_FOLLOWING', text: 'From someone you follow' },
  CONNECTION: { code: 'FROM_CONNECTION', text: 'From one of your connections' },
  RECENT_CONNECTION: { code: 'FROM_NEW_CONNECTION', text: 'From a new connection' },
  INTERACTED_CREATOR: { code: 'CREATOR_YOU_ENGAGE_WITH', text: 'From someone you engage with' },
  COLLEGE: { code: 'FROM_YOUR_COLLEGE', text: 'From your college' },
  COURSE: { code: 'FROM_YOUR_COURSE', text: 'From your course and year' },
  INTEREST: { code: 'MATCHES_INTERESTS', text: 'Matches your interests' },
  SKILL: { code: 'MATCHES_SKILLS', text: 'Matches your skills' },
  SECOND_DEGREE: { code: 'SECOND_DEGREE', text: 'From your extended network' },
  COHORT_POPULAR: { code: 'POPULAR_IN_COHORT', text: 'Popular with people like you' },
  TRENDING: { code: 'TRENDING_NOW', text: 'Getting attention right now' },
  RECENT: { code: 'RECENT_ON_VORMEX', text: 'Recent on Vormex' },
  DISCOVERY: { code: 'DISCOVER_SOMEONE_NEW', text: 'Someone new worth knowing' },
  NEW_CREATOR: { code: 'NEW_CREATOR', text: 'A new voice on Vormex' },
};

export interface FeedCandidateLimits {
  following: number;
  connection: number;
  recentConnection: number;
  interactedCreator: number;
  college: number;
  course: number;
  interest: number;
  skill: number;
  secondDegree: number;
  cohortPopular: number;
  trending: number;
  recent: number;
  discovery: number;
  newCreator: number;
}

export interface FeedRankingWeights {
  ownPost: number;
  following: number;
  connection: number;
  recentConnection: number;
  mutualFollow: number;
  secondDegree: number;
  relationshipStrength: number;
  sameCollege: number;
  sameCourse: number;
  sameYear: number;
  sharedInterests: number;
  sharedSkills: number;
  creatorAffinity: number;
  contentAffinity: number;
  freshness: number;
  engagementQuality: number;
  trendingVelocity: number;
  cohortProof: number;
  discoveryBonus: number;
  newCreatorExploration: number;
  contentCompleteness: number;
  premiumTieBreak: number;
}

export interface FeedRankingPenalties {
  seenWithinMinutes: number;
  seenWithinHours: number;
  seenToday: number;
  seenThisWeek: number;
  seenOlder: number;
  repeatImpression: number;
  creatorRepeatedInWindow: number;
  topicRepeatedInWindow: number;
  collegeRepeatedInWindow: number;
  sourceRepeatedInWindow: number;
  staleAge: number;
  skippedCreator: number;
  lowDwellCreator: number;
  negativeFeedbackRate: number;
  suspectedSpam: number;
}

export interface FeedFreshnessConfig {
  /** Hours after which a post keeps half of its freshness value. */
  halfLifeHours: number;
  /** Below this age a post is treated as brand new for exploration purposes. */
  newPostHours: number;
  /** Beyond this age the stale penalty reaches its full value. */
  staleAfterHours: number;
  /** Hard eligibility ceiling for organic candidates. */
  maxAgeHours: number;
}

export interface FeedEngagementConfig {
  /** Relative value of each interaction when computing weighted engagement. */
  weights: {
    like: number;
    comment: number;
    save: number;
    share: number;
    profileVisit: number;
    connection: number;
  };
  /**
   * Bayesian prior. `priorMass` pseudo-impressions at `priorRate` are added to
   * every post so a 1-like/1-impression post cannot outrank a proven one.
   */
  priorMass: number;
  priorRate: number;
  /** Reach floor so a post with no recorded impressions is not divided by zero. */
  minimumReach: number;
  /** Rate that maps to a full engagement score after normalisation. */
  saturationRate: number;
  /** Rolling window used for trending velocity. */
  velocityWindowHours: number;
  /** Engagements-per-hour that maps to a full velocity score. */
  velocitySaturation: number;
  /** Below this many unique engagers, engagement evidence is discounted. */
  minimumUniqueEngagers: number;
}

export interface FeedRelationshipConfig {
  /** Days after which a connection stops counting as "recent". */
  recentConnectionDays: number;
  /** Interaction lookback for affinity computation. */
  interactionLookbackDays: number;
  /** Half-life applied to interaction recency. */
  interactionHalfLifeDays: number;
  /** Per-signal contribution to the 0..1 relationship strength score. */
  weights: {
    following: number;
    connection: number;
    mutualFollow: number;
    recentConnection: number;
    messages: number;
    comments: number;
    likes: number;
    profileVisits: number;
    sharedCollege: number;
    sharedInterests: number;
    sharedSkills: number;
  };
  /** Counts at which each interaction signal saturates. */
  saturation: {
    messages: number;
    comments: number;
    likes: number;
    profileVisits: number;
  };
}

export interface FeedDiversityConfig {
  /** Look-back window (in already-placed items) for repetition penalties. */
  creatorWindow: number;
  topicWindow: number;
  collegeWindow: number;
  sourceWindow: number;
  /** Hard ceilings per page. Exceeding these applies the penalty, never removal. */
  maxPostsPerCreatorPerPage: number;
  maxConsecutiveSameSource: number;
  /** Never let one source own more than this fraction of a page. */
  maxSourceShare: number;
}

export interface FeedExplorationConfig {
  /** Target share of the page drawn from exploration sources. */
  targetShare: number;
  /** Cold-start users get more exploration. */
  coldStartTargetShare: number;
  /** Interactions below which a viewer counts as cold-start. */
  coldStartInteractionThreshold: number;
  /** Exploration never exceeds this share, however cold the viewer is. */
  maxShare: number;
  /**
   * An exploration item may only jump the queue if it is within this fraction of
   * the best remaining score. Keeps exploration from wrecking relevance.
   */
  maxScoreGapRatio: number;
  /** Impressions below which a post still qualifies for the new-post boost. */
  newPostImpressionCeiling: number;
  /** Followers below which a creator qualifies for the small-creator boost. */
  smallCreatorFollowerCeiling: number;
}

export interface FeedAntiGamingConfig {
  /** Ignore engagement beyond this many actions from a single actor per author. */
  maxEngagementsPerActorPerAuthor: number;
  /** Impressions required before a negative-feedback rate is trusted. */
  negativeFeedbackMinimumImpressions: number;
  /** Negative-feedback rate above which a post is dropped entirely. */
  negativeFeedbackDropRate: number;
  /** Posts by the same author inside this window are treated as burst posting. */
  authorBurstWindowHours: number;
  /** Posts above this count inside the burst window are demoted. */
  authorBurstThreshold: number;
  /** Skip ratio above which a creator is treated as repeatedly skipped. */
  creatorSkipRatio: number;
  /** Impressions required before a skip ratio is trusted. */
  creatorSkipMinimumImpressions: number;
}

export interface FeedSeenConfig {
  /** How far back impressions are considered at all. */
  lookbackDays: number;
  /** A post seen inside this many minutes is heavily demoted. */
  veryRecentMinutes: number;
  /** Tier boundaries, in hours. */
  recentHours: number;
  todayHours: number;
  weekHours: number;
  /** Impressions above which the repeat penalty stops growing. */
  maxCountedRepeats: number;
}

export interface FeedPaginationConfig {
  defaultPageSize: number;
  maxPageSize: number;
  /** Total ranked items stored in a feed session (all pages combined). */
  sessionSize: number;
  /** Feed session lifetime; a cursor stays resolvable this long. */
  sessionTtlMs: number;
  /**
   * How long a cached viewer context is served without a refresh.
   *
   * Past this the context is still served — it is refreshed in the background
   * instead, so the ten social-graph queries behind it never land on a user's
   * request. See viewerContextHardTtlSeconds for when it stops being served.
   */
  viewerContextTtlSeconds: number;
  /**
   * Absolute lifetime of a cached viewer context. Once past this it is a real
   * miss and the viewer waits for the rebuild. Must exceed
   * viewerContextTtlSeconds or background refresh never gets a chance to run.
   */
  viewerContextHardTtlSeconds: number;
  /** Candidate-pool cache lifetime. Short, so new posts surface quickly. */
  candidateCacheTtlSeconds: number;
}

export interface FeedConfig {
  enabled: boolean;
  /** Percentage of users on feed-v2, 0..100. Stable per user id. */
  rolloutPercent: number;
  rankingVersion: string;
  limits: FeedCandidateLimits;
  weights: FeedRankingWeights;
  penalties: FeedRankingPenalties;
  freshness: FeedFreshnessConfig;
  engagement: FeedEngagementConfig;
  relationship: FeedRelationshipConfig;
  diversity: FeedDiversityConfig;
  exploration: FeedExplorationConfig;
  antiGaming: FeedAntiGamingConfig;
  seen: FeedSeenConfig;
  pagination: FeedPaginationConfig;
}

/**
 * Starting values, not tuned truth. They encode intent — following matters a lot
 * but never enough to bury a strong college/interest/affinity post — and are
 * expected to move once §27 metrics come in from production.
 */
export const DEFAULT_FEED_CONFIG: FeedConfig = {
  enabled: true,
  rolloutPercent: 100,
  rankingVersion: FEED_RANKING_VERSION,

  limits: {
    following: 120,
    connection: 100,
    recentConnection: 40,
    interactedCreator: 60,
    college: 60,
    course: 40,
    interest: 60,
    skill: 60,
    secondDegree: 40,
    cohortPopular: 40,
    trending: 40,
    recent: 80,
    discovery: 40,
    newCreator: 30,
  },

  weights: {
    ownPost: 12,
    following: 30,
    connection: 25,
    recentConnection: 22,
    mutualFollow: 8,
    secondDegree: 6,
    relationshipStrength: 25,
    sameCollege: 15,
    sameCourse: 10,
    sameYear: 5,
    sharedInterests: 15,
    sharedSkills: 12,
    creatorAffinity: 25,
    contentAffinity: 20,
    freshness: 20,
    engagementQuality: 20,
    trendingVelocity: 12,
    cohortProof: 10,
    discoveryBonus: 8,
    newCreatorExploration: 10,
    contentCompleteness: 6,
    premiumTieBreak: 2,
  },

  penalties: {
    seenWithinMinutes: -55,
    seenWithinHours: -35,
    seenToday: -22,
    seenThisWeek: -10,
    seenOlder: -3,
    repeatImpression: -6,
    creatorRepeatedInWindow: -15,
    topicRepeatedInWindow: -10,
    collegeRepeatedInWindow: -5,
    sourceRepeatedInWindow: -6,
    staleAge: -12,
    skippedCreator: -18,
    lowDwellCreator: -8,
    negativeFeedbackRate: -20,
    suspectedSpam: -30,
  },

  freshness: {
    halfLifeHours: 18,
    newPostHours: 6,
    staleAfterHours: 168,
    maxAgeHours: 720,
  },

  engagement: {
    weights: {
      like: 1,
      comment: 3,
      save: 4,
      share: 5,
      profileVisit: 4,
      connection: 8,
    },
    priorMass: 25,
    priorRate: 0.04,
    minimumReach: 12,
    saturationRate: 0.35,
    velocityWindowHours: 24,
    velocitySaturation: 6,
    minimumUniqueEngagers: 3,
  },

  relationship: {
    recentConnectionDays: 14,
    interactionLookbackDays: 60,
    interactionHalfLifeDays: 14,
    weights: {
      following: 0.18,
      connection: 0.16,
      mutualFollow: 0.06,
      recentConnection: 0.08,
      messages: 0.14,
      comments: 0.12,
      likes: 0.08,
      profileVisits: 0.08,
      sharedCollege: 0.04,
      sharedInterests: 0.03,
      sharedSkills: 0.03,
    },
    saturation: {
      messages: 25,
      comments: 8,
      likes: 15,
      profileVisits: 6,
    },
  },

  diversity: {
    creatorWindow: 4,
    topicWindow: 3,
    collegeWindow: 4,
    sourceWindow: 3,
    maxPostsPerCreatorPerPage: 3,
    maxConsecutiveSameSource: 3,
    maxSourceShare: 0.55,
  },

  exploration: {
    targetShare: 0.2,
    coldStartTargetShare: 0.35,
    coldStartInteractionThreshold: 15,
    maxShare: 0.4,
    maxScoreGapRatio: 0.35,
    newPostImpressionCeiling: 150,
    smallCreatorFollowerCeiling: 100,
  },

  antiGaming: {
    maxEngagementsPerActorPerAuthor: 5,
    negativeFeedbackMinimumImpressions: 100,
    negativeFeedbackDropRate: 0.03,
    authorBurstWindowHours: 6,
    authorBurstThreshold: 4,
    creatorSkipRatio: 0.85,
    creatorSkipMinimumImpressions: 8,
  },

  seen: {
    lookbackDays: 14,
    veryRecentMinutes: 30,
    recentHours: 6,
    todayHours: 24,
    weekHours: 168,
    maxCountedRepeats: 4,
  },

  pagination: {
    defaultPageSize: 20,
    maxPageSize: 50,
    sessionSize: 150,
    sessionTtlMs: 6 * 60 * 60 * 1000,
    viewerContextTtlSeconds: 10 * 60,
    viewerContextHardTtlSeconds: 6 * 60 * 60,
    candidateCacheTtlSeconds: 60,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (!isPlainObject(override)) return base;
  const output = { ...(base as Record<string, unknown>) };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue;
    const current = output[key];
    output[key] = isPlainObject(current) && isPlainObject(value)
      ? mergeDeep(current, value as DeepPartial<typeof current>)
      : value;
  }

  return output as T;
}

function loadOverrides(): DeepPartial<FeedConfig> {
  const raw = process.env.FEED_V2_CONFIG_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? (parsed as DeepPartial<FeedConfig>) : {};
  } catch {
    // A malformed override must never take the feed down; defaults still serve.
    console.warn('[feed-config] FEED_V2_CONFIG_JSON is not valid JSON; using defaults');
    return {};
  }
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let cachedConfig: FeedConfig | null = null;

export function getFeedConfig(): FeedConfig {
  if (cachedConfig) return cachedConfig;

  const merged = mergeDeep(DEFAULT_FEED_CONFIG, loadOverrides());
  cachedConfig = {
    ...merged,
    // Discrete env vars win over the JSON blob so a kill switch is always a
    // single, obvious variable rather than a JSON edit under pressure.
    enabled: envBoolean('HOME_FEED_V2_ENABLED', merged.enabled),
    rolloutPercent: Math.min(100, Math.max(0, envNumber('HOME_FEED_V2_ROLLOUT_PERCENT', merged.rolloutPercent))),
    rankingVersion: process.env.FEED_V2_RANKING_VERSION || merged.rankingVersion,
  };
  return cachedConfig;
}

/** Test hook — drops the memoised config so env changes are picked up. */
export function resetFeedConfigCache(): void {
  cachedConfig = null;
}

/** Debug output is developer-only and must never reach a production client. */
export function isFeedDebugAllowed(): boolean {
  return envBoolean('FEED_V2_DEBUG_ENABLED', process.env.NODE_ENV !== 'production');
}
