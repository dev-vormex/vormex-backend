

import { DEFAULT_FEED_CONFIG, rankCandidate, type CandidateSource, type FeedCandidate, type FeedSignals, type FeedViewerContext, type ScoredFeedCandidate } from "../../modules/discovery/services/feed/index";

export const NOW = new Date('2026-08-14T12:00:00.000Z').getTime();

export const HOUR = 3_600_000;

export const config = DEFAULT_FEED_CONFIG;

export function viewer(overrides: Partial<FeedViewerContext> = {}): FeedViewerContext {
  return {
    userId: 'viewer-1',
    college: 'VIT Chennai',
    branch: 'Computer Science',
    degree: 'B.Tech',
    graduationYear: 2027,
    interestTokens: ['startups', 'design'],
    skillTokens: ['kotlin', 'machine learning'],
    educationTokens: ['vit chennai', 'computer science'],
    followingIds: [],
    connectionIds: [],
    recentConnectionIds: [],
    mutualFollowIds: [],
    secondDegreeIds: [],
    creatorAffinity: {},
    profileVisitAffinity: {},
    messageCounts: {},
    interactionCount: 40,
    isColdStart: false,
    ...overrides,
  };
}

export function signals(overrides: Partial<FeedSignals> = {}): FeedSignals {
  return {
    isFollowing: false,
    isConnection: false,
    isRecentConnection: false,
    isMutualFollow: false,
    isSecondDegree: false,
    relationshipStrength: 0,
    sameCollege: false,
    sameCourse: false,
    sameYear: false,
    sharedInterests: 0,
    sharedSkills: 0,
    creatorAffinity: 0,
    contentAffinity: 0,
    cohortProof: 0,
    freshness: 0.5,
    ageHours: 12,
    engagementQuality: 0,
    engagementVelocity: 0,
    contentCompleteness: 0,
    premiumTieBreak: 0,
    isNewPost: false,
    isNewCreator: false,
    explorationEligible: false,
    seenAt: null,
    seenCount: 0,
    lowDwell: false,
    creatorSkipped: false,
    negativeFeedbackRate: 0,
    authorBurst: false,
    ...overrides,
  };
}

export function candidate(
  postId: string,
  authorId: string,
  sources: CandidateSource[] = ['RECENT'],
  ageHours = 12
): FeedCandidate {
  return {
    postId,
    authorId,
    createdAt: new Date(NOW - ageHours * HOUR),
    sources: new Set(sources),
    sourceScores: {},
  };
}

export function post(id: string, authorId: string, ageHours = 12) {
  return {
    id,
    authorId,
    content: 'A post about building things',
    type: 'text',
    visibility: 'public',
    mediaUrls: [] as string[],
    metadata: null,
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0,
    createdAt: new Date(NOW - ageHours * HOUR),
    updatedAt: new Date(NOW - ageHours * HOUR),
  };
}

export function score(
  postId: string,
  authorId: string,
  overrides: { sources?: CandidateSource[]; signals?: Partial<FeedSignals>; ageHours?: number } = {}
): ScoredFeedCandidate {
  const ageHours = overrides.ageHours ?? 12;
  return rankCandidate({
    candidate: candidate(postId, authorId, overrides.sources ?? ['RECENT'], ageHours),
    post: post(postId, authorId, ageHours),
    author: undefined,
    signals: signals({ ageHours, ...overrides.signals }),
    viewer: viewer(),
    nowMs: NOW,
    config,
  });
}
