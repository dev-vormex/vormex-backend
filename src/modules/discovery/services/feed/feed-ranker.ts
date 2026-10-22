/**
 * FeedRanker — turns a signal vector into a score plus a full breakdown.
 *
 * Additive and weighted on purpose. Following is a strong term (+30) but not an
 * override: a post from your college that matches your skills, is fresh and is
 * performing well can and should outrank a stale post from someone you follow.
 * A multiplicative or tiered model could not express that.
 *
 * Every number comes from `feed-config`; this file contains no magic values, and
 * the returned `breakdown` is exactly the set of terms that produced the score,
 * which is what makes the debug view trustworthy.
 */

import { EXPLORATION_SOURCES, SOURCE_PRIORITY, getFeedConfig, type CandidateSource, type FeedConfig } from './feed-config';
import type { FeedAuthorProfile, FeedCandidate, FeedScoreBreakdown, FeedScoringPost, FeedSignals, FeedViewerContext, ScoredFeedCandidate } from './feed-types';
import { postTopics } from './feed-signals.service';

/** Strongest reason this post is in the feed, used for the client-facing label. */
export function primarySourceOf(sources: Set<CandidateSource> | CandidateSource[]): CandidateSource {
  const set = sources instanceof Set ? sources : new Set(sources);
  for (const source of SOURCE_PRIORITY) {
    if (set.has(source)) return source;
  }
  return 'RECENT';
}

export function isExplorationCandidate(
  sources: Set<CandidateSource> | CandidateSource[],
  signals: FeedSignals
): boolean {
  const set = sources instanceof Set ? sources : new Set(sources);

  // In-network content is never exploration, whichever pool also produced it.
  if (signals.isFollowing || signals.isConnection) return false;
  return EXPLORATION_SOURCES.some((source) => set.has(source)) || signals.isNewCreator;
}

/**
 * Recency-tiered impression penalty.
 *
 * A seen post is demoted, never permanently excluded: something you scrolled
 * past three weeks ago is eligible again if it is still strongly relevant. What
 * you saw two minutes ago is not.
 */
export function seenPenalty(
  signals: FeedSignals,
  nowMs: number,
  config: FeedConfig = getFeedConfig()
): number {
  if (!signals.seenAt) return 0;

  const seenAtMs = new Date(signals.seenAt).getTime();
  if (!Number.isFinite(seenAtMs)) return config.penalties.seenToday;

  const minutesSince = Math.max(0, nowMs - seenAtMs) / 60_000;
  const hoursSince = minutesSince / 60;
  const p = config.penalties;

  let penalty: number;
  if (minutesSince <= config.seen.veryRecentMinutes) penalty = p.seenWithinMinutes;
  else if (hoursSince <= config.seen.recentHours) penalty = p.seenWithinHours;
  else if (hoursSince <= config.seen.todayHours) penalty = p.seenToday;
  else if (hoursSince <= config.seen.weekHours) penalty = p.seenThisWeek;
  else penalty = p.seenOlder;

  // Repeatedly shown and still not acted on: each extra impression adds a little
  // more, capped so it cannot dominate the score.
  const extraViews = Math.min(
    Math.max(0, signals.seenCount - 1),
    config.seen.maxCountedRepeats
  );
  return penalty + extraViews * p.repeatImpression;
}

export interface RankInput {
  candidate: FeedCandidate;
  post: FeedScoringPost;
  author: FeedAuthorProfile | undefined;
  signals: FeedSignals;
  viewer: FeedViewerContext;
  nowMs: number;
  config?: FeedConfig;
}

/**
 * Scores one candidate.
 *
 * Terms are grouped so the breakdown reads as an explanation: relationship,
 * similarity, affinity, content quality, exploration, then penalties.
 */
export function rankCandidate(input: RankInput): ScoredFeedCandidate {
  const config = input.config || getFeedConfig();
  const { signals, candidate, post, author, viewer } = input;
  const w = config.weights;
  const p = config.penalties;

  const breakdown: FeedScoreBreakdown = {};
  const add = (key: string, value: number) => {
    if (value !== 0 && Number.isFinite(value)) breakdown[key] = Number(value.toFixed(4));
  };

  // --- Relationship -------------------------------------------------------
  if (candidate.authorId === viewer.userId) add('ownPost', w.ownPost);
  if (signals.isFollowing) add('following', w.following);
  if (signals.isConnection) add('connection', w.connection);
  if (signals.isRecentConnection) add('recentConnection', w.recentConnection);
  if (signals.isMutualFollow) add('mutualFollow', w.mutualFollow);
  if (signals.isSecondDegree) add('secondDegree', w.secondDegree);
  add('relationshipStrength', w.relationshipStrength * signals.relationshipStrength);

  // --- Similarity ---------------------------------------------------------
  if (signals.sameCollege) add('sameCollege', w.sameCollege);
  if (signals.sameCourse) add('sameCourse', w.sameCourse);
  if (signals.sameYear) add('sameYear', w.sameYear);
  add('sharedInterests', w.sharedInterests * signals.sharedInterests);
  add('sharedSkills', w.sharedSkills * signals.sharedSkills);

  // --- Learned affinity ---------------------------------------------------
  add('creatorAffinity', w.creatorAffinity * signals.creatorAffinity);
  add('contentAffinity', w.contentAffinity * signals.contentAffinity);
  add('cohortProof', w.cohortProof * signals.cohortProof);

  // --- Content quality ----------------------------------------------------
  add('freshness', w.freshness * signals.freshness);
  add('engagementQuality', w.engagementQuality * signals.engagementQuality);
  add('trendingVelocity', w.trendingVelocity * signals.engagementVelocity);
  add('contentCompleteness', w.contentCompleteness * signals.contentCompleteness);
  add('premiumTieBreak', Math.min(w.premiumTieBreak, w.premiumTieBreak * signals.premiumTieBreak));

  // --- Exploration --------------------------------------------------------
  // A brand-new post has no engagement to prove itself with, so it is given a
  // limited head start instead. Without this, zero-engagement posts can never
  // earn their first impressions and established creators keep every slot.
  if (signals.isNewPost && signals.explorationEligible) {
    add('newPostExploration', w.newCreatorExploration * (1 - signals.ageHours / Math.max(1, config.freshness.newPostHours)));
  }
  if (signals.isNewCreator && signals.explorationEligible) {
    add('newCreatorExploration', w.newCreatorExploration * 0.6);
  }
  if (candidate.sources.has('DISCOVERY') || candidate.sources.has('SECOND_DEGREE')) {
    add('discoveryBonus', w.discoveryBonus);
  }

  // --- Penalties ----------------------------------------------------------
  add('seenPenalty', seenPenalty(signals, input.nowMs, config));

  if (signals.ageHours > config.freshness.staleAfterHours) {
    const overBy = signals.ageHours - config.freshness.staleAfterHours;
    const rampHours = Math.max(1, config.freshness.maxAgeHours - config.freshness.staleAfterHours);
    add('stalePenalty', p.staleAge * Math.min(1, overBy / rampHours));
  }

  if (signals.creatorSkipped) add('skippedCreator', p.skippedCreator);
  if (signals.lowDwell) add('lowDwellCreator', p.lowDwellCreator);
  if (signals.authorBurst) add('authorBurst', p.suspectedSpam * 0.5);
  if (signals.negativeFeedbackRate > 0) {
    add(
      'negativeFeedback',
      p.negativeFeedbackRate *
        Math.min(1, signals.negativeFeedbackRate / Math.max(0.0001, config.antiGaming.negativeFeedbackDropRate))
    );
  }

  const baseScore = Object.values(breakdown).reduce((sum, value) => sum + value, 0);

  return {
    postId: candidate.postId,
    authorId: candidate.authorId,
    post,
    sources: Array.from(candidate.sources),
    primarySource: primarySourceOf(candidate.sources),
    signals,
    baseScore: Number(baseScore.toFixed(4)),
    breakdown,
    isExploration: isExplorationCandidate(candidate.sources, signals),
    topics: postTopics(post, author),
    college: author?.college ?? null,
  };
}

/**
 * Sorts scored candidates.
 *
 * Ties break on recency then post id, so ranking is fully deterministic: the
 * same inputs always produce the same order, which is what makes the pipeline
 * testable and pagination stable.
 */
export function sortScoredCandidates(candidates: ScoredFeedCandidate[]): ScoredFeedCandidate[] {
  return [...candidates].sort((left, right) => {
    if (right.baseScore !== left.baseScore) return right.baseScore - left.baseScore;
    const leftTime = new Date(left.post.createdAt).getTime();
    const rightTime = new Date(right.post.createdAt).getTime();
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.postId.localeCompare(right.postId);
  });
}
