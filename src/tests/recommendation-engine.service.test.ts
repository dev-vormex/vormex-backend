import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FEATURE_PRIORS,
  applyConstrainedPositionExploration,
  allocateCandidateSources,
  betaProbabilityAboveBaseline,
  evaluateCascadeGate,
  inversePropensityWeight,
  learnedUtility,
  qualifiesExposure,
  rankRecommendationCandidates,
  scoreRecommendationCandidate,
  sourceQuotaCounts,
  type RecommendationCandidate,
} from '../services/recommendation-engine.service';
import {
  decodeRecommendationCursor,
  encodeRecommendationCursor,
} from '../services/recommendation-platform.service';
import { blendRecommendationPreferenceVector } from '../services/recommendation-embedding.service';

function candidate(id: string, overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return {
    id,
    entityType: 'POST',
    authorId: `author-${id}`,
    value: { id },
    sources: ['EXPLORATION'],
    features: {},
    ...overrides,
  };
}

test('missing features use surface priors without weight renormalization', () => {
  const score = scoreRecommendationCandidate(candidate('one', {
    sources: ['SEMANTIC'],
    features: { semantic: 1 },
  }), DEFAULT_FEATURE_PRIORS);
  assert.equal(score, 0.5325);
});

test('candidate source quotas total 500 and backfill without duplicates', () => {
  assert.deepEqual(sourceQuotaCounts(500), {
    NETWORK: 150,
    NETWORK_ENGAGED: 125,
    SEMANTIC: 100,
    COHORT_TRENDING: 75,
    EXPLORATION: 50,
  });
  const candidates = Array.from({ length: 80 }, (_, index) => candidate(`post-${index}`, {
    sources: index < 5 ? ['NETWORK'] : ['EXPLORATION'],
    features: { freshness: 1 - index / 100 },
  }));
  const allocated = allocateCandidateSources(candidates, 60);
  assert.equal(allocated.length, 60);
  assert.equal(new Set(allocated.map((item) => item.id)).size, 60);
});

test('source shortages backfill proportionally from remaining inventory', () => {
  const candidates = [
    ...Array.from({ length: 2 }, (_, index) => candidate(`network-${index}`, { sources: ['NETWORK'] })),
    ...Array.from({ length: 40 }, (_, index) => candidate(`semantic-${index}`, { sources: ['SEMANTIC'] })),
    ...Array.from({ length: 40 }, (_, index) => candidate(`cohort-${index}`, { sources: ['COHORT_TRENDING'] })),
  ];
  const allocated = allocateCandidateSources(candidates, 20);
  const counts = allocated.reduce<Record<string, number>>((result, item) => {
    result[item.primarySource] = (result[item.primarySource] || 0) + 1;
    return result;
  }, {});
  assert.equal(allocated.length, 20);
  assert.equal(counts.NETWORK, 2);
  assert.ok((counts.SEMANTIC || 0) > (counts.COHORT_TRENDING || 0));
});

test('reranking avoids adjacent authors and caps an author to two in the first 20', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => candidate(`post-${index}`, {
    authorId: index < 10 ? 'popular-author' : `author-${index}`,
    sources: index % 3 === 0 ? ['NETWORK'] : ['EXPLORATION'],
    features: { freshness: 1 - index / 100 },
  }));
  const ranked = rankRecommendationCandidates(candidates, { applySeenSuppression: false });
  for (let index = 1; index < ranked.length; index += 1) {
    assert.notEqual(ranked[index].authorId, ranked[index - 1].authorId);
  }
  assert.ok(ranked.slice(0, 20).filter((item) => item.authorId === 'popular-author').length <= 2);
});

test('seven-day suppression restores oldest views when inventory falls below 60', () => {
  const now = new Date('2026-07-22T10:00:00Z').getTime();
  const candidates = Array.from({ length: 70 }, (_, index) => candidate(`post-${index}`, {
    seenAt: index < 20 ? new Date(now - index * 60_000) : null,
  }));
  const ranked = rankRecommendationCandidates(candidates, { nowMs: now });
  assert.equal(ranked.length, 60);
  assert.ok(ranked.some((item) => item.seenAt));
});

test('qualified exposure thresholds include strict Reel playback rule', () => {
  assert.equal(qualifiesExposure({ surface: 'HOME', maxVisibleFraction: 0.5, visibleTimeMs: 1_000 }), true);
  assert.equal(qualifiesExposure({ surface: 'STORIES', maxVisibleFraction: 0.5, visibleTimeMs: 1_999 }), false);
  assert.equal(qualifiesExposure({ surface: 'REELS', maxVisibleFraction: 0.8, playbackTimeMs: 2_999, mediaDurationMs: 4_000 }), false);
  assert.equal(qualifiesExposure({ surface: 'REELS', maxVisibleFraction: 0.8, playbackTimeMs: 3_000, mediaDurationMs: 4_000 }), true);
  assert.equal(qualifiesExposure({ surface: 'REELS', maxVisibleFraction: 0.8, playbackTimeMs: 4_999, mediaDurationMs: 20_000 }), false);
  assert.equal(qualifiesExposure({ surface: 'REELS', maxVisibleFraction: 0.8, playbackTimeMs: 5_000, mediaDurationMs: 20_000 }), true);
});

test('Bayesian cascade gates expand strong items and stop clear underperformance', () => {
  assert.ok(betaProbabilityAboveBaseline(8, 12, 0.08) >= 0.70);
  const expansion = evaluateCascadeGate({
    qualifiedImpressions: 20,
    cascadeEngagements: 8,
    independentReactors: 1,
    baseline: 0.08,
  });
  assert.equal(expansion.action, 'EXPAND_TO_75');
  assert.ok(expansion.maximumAdditionalViewers <= 55);

  const stop = evaluateCascadeGate({
    qualifiedImpressions: 120,
    cascadeEngagements: 0,
    independentReactors: 0,
    baseline: 0.08,
    trailingWeightedSuccesses: 0,
    trailingWeightedFailures: 100,
  });
  assert.equal(stop.action, 'STOP');
});

test('signed recommendation cursors reject tampering and bind snapshot fields', () => {
  const cursor = encodeRecommendationCursor({
    v: 1,
    sid: 'session-1',
    uid: 'user-1',
    surface: 'HOME',
    offset: 40,
    snapshotAt: '2026-07-22T10:00:00.000Z',
    rankerVersion: 'ranker-1',
    experimentVariant: 'treatment',
  });
  assert.equal(decodeRecommendationCursor(cursor)?.offset, 40);
  assert.equal(decodeRecommendationCursor(`${cursor.slice(0, -1)}x`), null);
});

test('inverse propensity weights are normalized and capped', () => {
  assert.equal(inversePropensityWeight(0.5, 1), 2);
  assert.equal(inversePropensityWeight(0.001, 1), 10);
});

test('position exploration preserves neighbor author diversity', () => {
  const ranked = rankRecommendationCandidates([
    candidate('a', { authorId: 'author-a', features: { freshness: 1 } }),
    candidate('b', { authorId: 'author-b', features: { freshness: 0.99 } }),
    candidate('c', { authorId: 'author-c', features: { freshness: 0.98 } }),
    candidate('d', { authorId: 'author-b', features: { freshness: 0.97 } }),
    candidate('e', { authorId: 'author-e', features: { freshness: 0.96 } }),
  ], { applySeenSuppression: false });
  const explored = applyConstrainedPositionExploration(ranked, 'fixed-seed', 1);
  for (let index = 1; index < explored.length; index += 1) {
    assert.notEqual(explored[index].authorId, explored[index - 1].authorId);
  }
});

test('learned heads retain prior weight and blend 70/30 with heuristic utility', () => {
  const utility = learnedUtility(
    { useful: 1, qualityDwell: null, skip: null, negative: 0 },
    { useful: 0.1, qualityDwell: 0.2, skip: 0.4, negative: 0.05 }
  );
  assert.ok(Math.abs(utility - 0.72) < Number.EPSILON * 2);

  const blended = scoreRecommendationCandidate(candidate('blended', {
    features: {
      semantic: 0,
      relationship: 0,
      socialProof: 0,
      quality: 0,
      freshness: 0,
      exploration: 0,
      cohortFit: 0,
    },
    learnedUtility: 1,
    premiumTieBreak: 1,
  }));
  assert.equal(blended, 0.72);
});

test('preference vectors cap behavior at 70 percent and subtract the negative centroid', () => {
  const dimension = 1_536;
  const basis = (index: number) => Array.from({ length: dimension }, (_, item) => item === index ? 1 : 0);
  const now = new Date('2026-07-22T10:00:00.000Z');
  const result = blendRecommendationPreferenceVector({
    profileVector: basis(0),
    interactions: Array.from({ length: 50 }, () => ({ vector: basis(1), occurredAt: now })),
    negativeVectors: [basis(2)],
    now,
  });
  assert.equal(result.behavioralWeight, 0.7);
  assert.ok(result.positiveVector);
  assert.ok((result.positiveVector?.[1] || 0) > (result.positiveVector?.[0] || 0));
  assert.ok((result.positiveVector?.[2] || 0) < 0);
  assert.equal(result.negativeVector?.[2], 1);
});
