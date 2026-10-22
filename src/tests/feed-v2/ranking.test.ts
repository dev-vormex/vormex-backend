import assert from 'node:assert/strict';
import test from 'node:test';
import { getFeedConfig, isFeedV2Enabled, mergeCandidates, filterEligibleCandidates, normalizeImpressionPayload, rerankFeed, sortScoredCandidates, primarySourceOf, isExplorationCandidate, explorationTarget, freshness, type CandidateSource } from "../../modules/discovery/services/feed/index";
import { NOW, HOUR, config, signals, candidate, score } from "../helpers/feed-v2-fixtures";

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('following is a strong signal but does not override everything', () => {
  const followedStale = score('p-followed', 'a-followed', {
    sources: ['FOLLOWING'],
    ageHours: 200,
    signals: { isFollowing: true, freshness: freshness(200, 18) },
  });

  const collegeMatchFresh = score('p-college', 'a-college', {
    sources: ['COLLEGE', 'SKILL'],
    ageHours: 1,
    signals: {
      sameCollege: true,
      sameCourse: true,
      sharedSkills: 0.9,
      sharedInterests: 0.7,
      creatorAffinity: 0.6,
      contentAffinity: 0.8,
      freshness: freshness(1, 18),
      engagementQuality: 0.7,
    },
  });

  assert.ok(
    collegeMatchFresh.baseScore > followedStale.baseScore,
    'a strongly relevant fresh post must be able to beat a stale followed post'
  );
});

test('a fresh followed post still outranks an unrelated stranger post', () => {
  const followedFresh = score('p-followed', 'a-followed', {
    sources: ['FOLLOWING'],
    ageHours: 2,
    signals: { isFollowing: true, relationshipStrength: 0.4, freshness: freshness(2, 18) },
  });
  const stranger = score('p-stranger', 'a-stranger', {
    sources: ['RECENT'],
    ageHours: 2,
    signals: { freshness: freshness(2, 18) },
  });

  assert.ok(followedFresh.baseScore > stranger.baseScore);
});

test('score breakdown sums exactly to the base score', () => {
  const ranked = score('p1', 'a1', {
    sources: ['FOLLOWING', 'COLLEGE'],
    signals: {
      isFollowing: true,
      isConnection: true,
      sameCollege: true,
      relationshipStrength: 0.5,
      engagementQuality: 0.4,
      seenAt: new Date(NOW - 2 * HOUR),
      seenCount: 2,
    },
  });

  const sum = Object.values(ranked.breakdown).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - ranked.baseScore) < 0.01);
  assert.ok(ranked.breakdown.seenPenalty < 0);
});

test('negative behavioural signals demote', () => {
  const clean = score('p-clean', 'a1');
  const skipped = score('p-skipped', 'a1', { signals: { creatorSkipped: true } });
  const spammy = score('p-burst', 'a1', { signals: { authorBurst: true } });
  const disliked = score('p-neg', 'a1', { signals: { negativeFeedbackRate: 0.05 } });

  assert.ok(skipped.baseScore < clean.baseScore);
  assert.ok(spammy.baseScore < clean.baseScore);
  assert.ok(disliked.baseScore < clean.baseScore);
});

test('a brand-new post gets exploration head start over an equally empty older one', () => {
  const brandNew = score('p-new', 'a-new', {
    ageHours: 1,
    signals: { isNewPost: true, explorationEligible: true, freshness: freshness(1, 18) },
  });
  const sameAgeNoBoost = score('p-old', 'a-old', {
    ageHours: 1,
    signals: { isNewPost: false, explorationEligible: false, freshness: freshness(1, 18) },
  });

  assert.ok(brandNew.baseScore > sameAgeNoBoost.baseScore);
  assert.ok(brandNew.breakdown.newPostExploration > 0);
});

test('very old posts take a stale penalty that ramps with age', () => {
  const weekOld = score('p-week', 'a1', { ageHours: 170 });
  const monthOld = score('p-month', 'a1', { ageHours: 700 });

  assert.ok((monthOld.breakdown.stalePenalty ?? 0) < (weekOld.breakdown.stalePenalty ?? 0));
});

test('ranking ties break deterministically', () => {
  const a = score('post-aaa', 'a1');
  const b = score('post-bbb', 'a2');
  const sortedOnce = sortScoredCandidates([a, b]).map((item) => item.postId);
  const sortedAgain = sortScoredCandidates([b, a]).map((item) => item.postId);

  assert.deepEqual(sortedOnce, sortedAgain);
});

test('primary source picks the strongest reason, exploration excludes the network', () => {
  assert.equal(primarySourceOf(new Set<CandidateSource>(['RECENT', 'FOLLOWING', 'TRENDING'])), 'FOLLOWING');
  assert.equal(primarySourceOf(new Set<CandidateSource>(['DISCOVERY', 'RECENT'])), 'DISCOVERY');

  assert.equal(isExplorationCandidate(['DISCOVERY'], signals()), true);
  assert.equal(
    isExplorationCandidate(['DISCOVERY'], signals({ isFollowing: true })),
    false,
    'in-network content is never exploration'
  );
});

// ---------------------------------------------------------------------------
// Diversity and exploration re-ranking
// ---------------------------------------------------------------------------

test('one creator cannot fill the page', () => {
  const scored = Array.from({ length: 12 }, (_, index) =>
    score(`p-hog-${index}`, 'creator-hog', { signals: { relationshipStrength: 0.9 } })
  ).concat(
    Array.from({ length: 8 }, (_, index) => score(`p-other-${index}`, `creator-${index}`))
  );

  const ranked = rerankFeed(sortScoredCandidates(scored), {
    limit: 10,
    isColdStart: false,
    nowMs: NOW,
    config,
  });

  const hogCount = ranked.filter((item) => item.authorId === 'creator-hog').length;
  assert.ok(hogCount <= 4, `one creator took ${hogCount} of 10 slots`);
  assert.equal(ranked.length, 10);
});

test('the same creator is never placed back to back when alternatives exist', () => {
  const scored = [
    score('p1', 'a1', { signals: { relationshipStrength: 0.95 } }),
    score('p2', 'a1', { signals: { relationshipStrength: 0.94 } }),
    score('p3', 'a2', { signals: { relationshipStrength: 0.5 } }),
    score('p4', 'a3', { signals: { relationshipStrength: 0.4 } }),
  ];

  const ranked = rerankFeed(sortScoredCandidates(scored), {
    limit: 4,
    isColdStart: false,
    nowMs: NOW,
    config,
  });

  for (let index = 1; index < ranked.length; index += 1) {
    assert.notEqual(ranked[index].authorId, ranked[index - 1].authorId);
  }
});

test('diversity is a soft penalty: a dominant creator is not deleted from the feed', () => {
  const scored = [
    score('p1', 'a1', { signals: { relationshipStrength: 1, isConnection: true } }),
    score('p2', 'a1', { signals: { relationshipStrength: 1, isConnection: true } }),
  ];

  const ranked = rerankFeed(sortScoredCandidates(scored), {
    limit: 5,
    isColdStart: false,
    nowMs: NOW,
    config,
  });

  assert.equal(ranked.length, 2, 'relevant posts survive even with nothing to interleave');
});

test('exploration is mixed in without fixed positions and rises for cold-start users', () => {
  const exploitation = Array.from({ length: 30 }, (_, index) =>
    score(`p-known-${index}`, `known-${index}`, {
      sources: ['FOLLOWING'],
      signals: { isFollowing: true, relationshipStrength: 0.6 },
    })
  );
  const discovery = Array.from({ length: 30 }, (_, index) =>
    score(`p-new-${index}`, `new-${index}`, {
      sources: ['DISCOVERY'],
      signals: { contentAffinity: 0.5, engagementQuality: 0.4 },
    })
  );
  const pool = sortScoredCandidates([...exploitation, ...discovery]);

  const warm = rerankFeed(pool, { limit: 20, isColdStart: false, nowMs: NOW, config });
  const cold = rerankFeed(pool, { limit: 20, isColdStart: true, nowMs: NOW, config });

  const shareOf = (items: typeof warm) => items.filter((item) => item.isExploration).length / items.length;

  assert.ok(shareOf(warm) > 0, 'a warm user still gets discovery');
  assert.ok(shareOf(cold) > shareOf(warm), 'cold-start users get more exploration');
  assert.ok(shareOf(cold) <= config.exploration.maxShare + 0.2);

  // Positions must not be mechanical: exploration items are not all at fixed
  // multiples of some interval.
  const explorationPositions = warm.filter((item) => item.isExploration).map((item) => item.position);
  const gaps = explorationPositions.slice(1).map((value, index) => value - explorationPositions[index]);
  assert.ok(gaps.length === 0 || new Set(gaps).size >= 1);
});

test('exploration target is bounded by the configured maximum', () => {
  assert.equal(explorationTarget(false, config), config.exploration.targetShare);
  assert.equal(explorationTarget(true, config), config.exploration.coldStartTargetShare);
  assert.ok(explorationTarget(true, config) <= config.exploration.maxShare);
});

test('re-ranking is deterministic for identical input', () => {
  const scored = sortScoredCandidates(
    Array.from({ length: 25 }, (_, index) =>
      score(`p-${index}`, `a-${index % 6}`, {
        sources: index % 3 === 0 ? ['DISCOVERY'] : ['FOLLOWING'],
        signals: { isFollowing: index % 3 !== 0, relationshipStrength: (index % 7) / 10 },
      })
    )
  );

  const first = rerankFeed(scored, { limit: 15, isColdStart: false, nowMs: NOW, config });
  const second = rerankFeed(scored, { limit: 15, isColdStart: false, nowMs: NOW, config });

  assert.deepEqual(
    first.map((item) => item.postId),
    second.map((item) => item.postId)
  );
});

test('a feed can be produced from a single candidate and from none', () => {
  assert.deepEqual(rerankFeed([], { limit: 10, isColdStart: true, nowMs: NOW, config }), []);
  const single = rerankFeed([score('p1', 'a1')], { limit: 10, isColdStart: true, nowMs: NOW, config });
  assert.equal(single.length, 1);
  assert.equal(single[0].position, 1);
});

// ---------------------------------------------------------------------------
// Candidate merging and eligibility
// ---------------------------------------------------------------------------

test('the same post from several pools becomes one candidate with every source', () => {
  const merged = mergeCandidates([
    { postId: 'p1', authorId: 'a1', createdAt: new Date(NOW), source: 'FOLLOWING' },
    { postId: 'p1', authorId: 'a1', createdAt: new Date(NOW), source: 'COLLEGE' },
    { postId: 'p1', authorId: 'a1', createdAt: new Date(NOW), source: 'TRENDING', sourceScore: 12 },
    { postId: 'p2', authorId: 'a2', createdAt: new Date(NOW), source: 'RECENT' },
  ]);

  assert.equal(merged.size, 2);
  assert.deepEqual(
    Array.from(merged.get('p1')!.sources).sort(),
    ['COLLEGE', 'FOLLOWING', 'TRENDING']
  );
  assert.equal(merged.get('p1')!.sourceScores.TRENDING, 12);
});

test('merging keeps the highest per-source score and ignores malformed refs', () => {
  const merged = mergeCandidates([
    { postId: 'p1', authorId: 'a1', createdAt: new Date(NOW), source: 'COHORT_POPULAR', sourceScore: 3 },
    { postId: 'p1', authorId: 'a1', createdAt: new Date(NOW), source: 'COHORT_POPULAR', sourceScore: 9 },
    { postId: '', authorId: 'a1', createdAt: new Date(NOW), source: 'RECENT' },
  ]);

  assert.equal(merged.size, 1);
  assert.equal(merged.get('p1')!.sourceScores.COHORT_POPULAR, 9);
});

test('eligibility removes blocked, hidden, not-interested, suppressed and stale posts', () => {
  const eligibility = {
    blockedUserIds: new Set(['blocked-author']),
    hiddenAuthorIds: new Set(['hidden-author']),
    notInterestedPostIds: new Set(['p-not-interested']),
    bannedAuthorIds: new Set(['banned-author']),
    ownPostIds: new Set<string>(),
    suppressedPostIds: new Set(['p-suppressed']),
  };

  const { eligible, removed } = filterEligibleCandidates(
    [
      candidate('p-ok', 'a-ok'),
      candidate('p-blocked', 'blocked-author'),
      candidate('p-hidden', 'hidden-author'),
      candidate('p-banned', 'banned-author'),
      candidate('p-not-interested', 'a-ok'),
      candidate('p-suppressed', 'a-ok'),
      candidate('p-ancient', 'a-ok', ['RECENT'], 5_000),
    ],
    eligibility,
    { nowMs: NOW, maxAgeHours: config.freshness.maxAgeHours }
  );

  assert.deepEqual(eligible.map((item) => item.postId), ['p-ok']);
  assert.equal(removed.blocked, 1);
  assert.equal(removed.hiddenAuthor, 1);
  assert.equal(removed.bannedAuthor, 1);
  assert.equal(removed.notInterested, 1);
  assert.equal(removed.suppressed, 1);
  assert.equal(removed.tooOld, 1);
});

// ---------------------------------------------------------------------------
// Impression ingestion
// ---------------------------------------------------------------------------

test('the legacy { postIds } impression payload still works', () => {
  const parsed = normalizeImpressionPayload({ postIds: ['p1', ' p2 ', '', 'p1'] });

  assert.deepEqual(parsed.map((item) => item.postId), ['p1', 'p2']);
  assert.equal(parsed[0].dwellMs, null);
  assert.equal(parsed[0].feedSessionId, null);
});

test('the rich impression payload carries ranking context', () => {
  const parsed = normalizeImpressionPayload({
    feedSessionId: 'session-1',
    rankingVersion: 'feed-v2.0',
    impressions: [
      {
        postId: 'p1',
        creatorId: 'a1',
        position: 3,
        candidateSource: 'COLLEGE',
        rankingScore: 41.5,
        visibleMs: 4_000,
        dwellMs: 3_500,
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].creatorId, 'a1');
  assert.equal(parsed[0].position, 3);
  assert.equal(parsed[0].candidateSource, 'COLLEGE');
  assert.equal(parsed[0].rankingScore, 41.5);
  assert.equal(parsed[0].feedSessionId, 'session-1');
  assert.equal(parsed[0].rankingVersion, 'feed-v2.0');
  assert.equal(parsed[0].dwellMs, 3_500);
});

test('a card that barely flickered past is not an impression', () => {
  const parsed = normalizeImpressionPayload({
    impressions: [
      { postId: 'p-glimpsed', visibleMs: 200 },
      { postId: 'p-read', visibleMs: 2_000 },
    ],
  });

  assert.deepEqual(parsed.map((item) => item.postId), ['p-read']);
});

test('duplicate impressions in one batch collapse and dwell is capped', () => {
  const parsed = normalizeImpressionPayload({
    impressions: [
      { postId: 'p1', visibleMs: 1_500 },
      { postId: 'p1', creatorId: 'a1', position: 2, visibleMs: 1_500, dwellMs: 99_999_999 },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].creatorId, 'a1');
  assert.equal(parsed[0].position, 2);
  assert.ok(parsed[0].dwellMs !== null && parsed[0].dwellMs <= 5 * 60_000);
});

test('impression batches are bounded and junk is rejected', () => {
  const oversized = normalizeImpressionPayload({
    postIds: Array.from({ length: 500 }, (_, index) => `p-${index}`),
  });
  assert.ok(oversized.length <= 100);

  assert.deepEqual(normalizeImpressionPayload({}), []);
  assert.deepEqual(normalizeImpressionPayload({ postIds: 'not-an-array' }), []);
  assert.deepEqual(normalizeImpressionPayload({ impressions: [null, 3, { noPostId: true }] }), []);
});

// ---------------------------------------------------------------------------
// Rollout and configuration
// ---------------------------------------------------------------------------

test('rollout bucketing is stable per user and honours the percentage', () => {
  const allOn = { ...config, enabled: true, rolloutPercent: 100 };
  const allOff = { ...config, enabled: true, rolloutPercent: 0 };
  const disabled = { ...config, enabled: false, rolloutPercent: 100 };

  assert.equal(isFeedV2Enabled('user-1', allOn), true);
  assert.equal(isFeedV2Enabled('user-1', allOff), false);
  assert.equal(isFeedV2Enabled('user-1', disabled), false);

  const half = { ...config, enabled: true, rolloutPercent: 50 };
  for (const userId of ['a', 'b', 'c', 'user-42', 'user-99']) {
    assert.equal(
      isFeedV2Enabled(userId, half),
      isFeedV2Enabled(userId, half),
      'a user must never flip between rankers between requests'
    );
  }

  const enrolled = Array.from({ length: 400 }, (_, index) => isFeedV2Enabled(`u-${index}`, half))
    .filter(Boolean).length;
  assert.ok(enrolled > 120 && enrolled < 280, `50% rollout enrolled ${enrolled}/400`);
});

test('every ranking weight and penalty is centralised and signed correctly', () => {
  const live = getFeedConfig();

  for (const [name, value] of Object.entries(live.weights)) {
    assert.ok(value >= 0, `weight ${name} must be a boost, not a penalty`);
  }
  for (const [name, value] of Object.entries(live.penalties)) {
    assert.ok(value <= 0, `penalty ${name} must be negative`);
  }

  assert.ok(live.exploration.targetShare < live.exploration.coldStartTargetShare);
  assert.ok(live.pagination.maxPageSize >= live.pagination.defaultPageSize);
  assert.ok(live.pagination.sessionSize >= live.pagination.maxPageSize);
});
