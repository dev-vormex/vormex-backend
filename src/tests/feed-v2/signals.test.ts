import assert from 'node:assert/strict';
import test from 'node:test';
import { seenPenalty, relationshipStrength, scoreRelationship, saturate, sharedRatio, decayedCount, engagementQuality, engagementVelocity, weightedEngagement, trendingScore, freshness } from "../../modules/discovery/services/feed/index";
import { NOW, HOUR, config, signals } from "../helpers/feed-v2-fixtures";

// ---------------------------------------------------------------------------
// Relationship scoring
// ---------------------------------------------------------------------------

test('relationship strength stays in 0..1 and rewards more signals', () => {
  const stranger = relationshipStrength({}, config.relationship);
  const follower = relationshipStrength({ isFollowing: true }, config.relationship);
  const closeFriend = relationshipStrength(
    {
      isFollowing: true,
      isFollowedBy: true,
      isConnection: true,
      isRecentConnection: true,
      messagesCount: 60,
      commentsBetweenUsers: 20,
      likesBetweenUsers: 40,
      profileVisits: 12,
      sameCollege: true,
      sharedInterestsCount: 4,
      viewerInterestsCount: 5,
      sharedSkillsCount: 3,
      viewerSkillsCount: 4,
    },
    config.relationship
  );

  assert.equal(stranger, 0);
  assert.ok(follower > 0 && follower < closeFriend);
  assert.ok(closeFriend <= 1);
});

test('interaction counts saturate so one heavy peer cannot dominate', () => {
  const ten = saturate(10, 25);
  const hundred = saturate(100, 25);
  const thousand = saturate(1_000, 25);

  assert.ok(ten < hundred);
  assert.ok(hundred <= 1);
  // Ten times more messages must not be ten times the signal.
  assert.ok(thousand - hundred < hundred - ten);
});

test('interactions decay with recency', () => {
  const fresh = decayedCount(10, new Date(NOW - 1 * 86_400_000), 14, NOW);
  const old = decayedCount(10, new Date(NOW - 60 * 86_400_000), 14, NOW);

  assert.ok(fresh > 9);
  assert.ok(old < 1);
  assert.ok(fresh > old);
});

test('shared attributes are normalised, not counted', () => {
  // Three shared out of four interests beats three shared out of a huge profile
  // only up to the cap; both must stay bounded at 1.
  assert.ok(sharedRatio(3, 4) > sharedRatio(1, 4));
  assert.ok(sharedRatio(50, 60) <= 1);
  assert.equal(sharedRatio(0, 10), 0);
});

test('relationship breakdown exposes every contributing component', () => {
  const { components, score: total } = scoreRelationship(
    { isFollowing: true, isConnection: true, messagesCount: 10 },
    config.relationship
  );

  assert.ok(components.following > 0);
  assert.ok(components.connection > 0);
  assert.ok(components.messages > 0);
  assert.equal(components.profileVisits, 0);
  assert.ok(Math.abs(Object.values(components).reduce((a, b) => a + b, 0) - total) < 1e-9);
});

// ---------------------------------------------------------------------------
// Engagement normalisation
// ---------------------------------------------------------------------------

test('engagement is normalised by reach, so raw likes never win alone', () => {
  const viral = engagementQuality(
    { likes: 500, comments: 10, impressions: 200_000, uniqueEngagers: 510 },
    config.engagement
  );
  const smallButLoved = engagementQuality(
    { likes: 40, comments: 12, saves: 8, impressions: 300, uniqueEngagers: 60 },
    config.engagement
  );

  assert.ok(smallButLoved > viral, 'high-rate small post must beat low-rate viral post');
});

test('a one-like post cannot outrank a proven one', () => {
  const tiny = engagementQuality({ likes: 1, impressions: 1, uniqueEngagers: 1 }, config.engagement);
  const proven = engagementQuality(
    { likes: 60, comments: 20, saves: 10, impressions: 500, uniqueEngagers: 70 },
    config.engagement
  );

  assert.ok(tiny < proven, 'Bayesian prior must damp a single-sample rate');
});

test('engagement concentrated in too few accounts is discounted', () => {
  const ring = engagementQuality(
    { likes: 30, impressions: 100, uniqueEngagers: 1 },
    config.engagement
  );
  const organic = engagementQuality(
    { likes: 30, impressions: 100, uniqueEngagers: 30 },
    config.engagement
  );

  assert.ok(ring < organic);
});

test('interaction types are weighted by intent', () => {
  const base = { likes: 0, comments: 0, saves: 0, shares: 0 };
  const likes = weightedEngagement({ ...base, likes: 10 }, config.engagement);
  const comments = weightedEngagement({ ...base, comments: 10 }, config.engagement);
  const shares = weightedEngagement({ ...base, shares: 10 }, config.engagement);

  assert.ok(likes < comments);
  assert.ok(comments < shares);
});

test('velocity measures a rolling window and decays with age', () => {
  const bursting = engagementVelocity({ recentEngagement: 60, ageHours: 4 }, config.engagement);
  const trickle = engagementVelocity({ recentEngagement: 60, ageHours: 24 }, config.engagement);

  assert.ok(bursting > trickle);
  assert.equal(engagementVelocity({ recentEngagement: 0, ageHours: 4 }, config.engagement), 0);

  // Nothing trends forever: the same window engagement on a much older post
  // scores far lower once age decay is applied.
  const freshTrend = trendingScore({ recentEngagement: 60, uniqueEngagers: 20, ageHours: 4 }, config.engagement);
  const staleTrend = trendingScore({ recentEngagement: 60, uniqueEngagers: 20, ageHours: 96 }, config.engagement);
  assert.ok(freshTrend > staleTrend * 4);
});

// ---------------------------------------------------------------------------
// Freshness and seen penalties
// ---------------------------------------------------------------------------

test('freshness decays exponentially rather than sorting by createdAt', () => {
  const now = freshness(0, 18);
  const halfLife = freshness(18, 18);
  const twoHalfLives = freshness(36, 18);

  assert.equal(now, 1);
  assert.ok(Math.abs(halfLife - 0.5) < 1e-9);
  assert.ok(Math.abs(twoHalfLives - 0.25) < 1e-9);
  // Old content is diminished, never zeroed, so a great old post stays eligible.
  assert.ok(freshness(240, 18) > 0);
});

test('seen penalty is tiered by recency and never permanent exclusion', () => {
  const minutesAgo = seenPenalty(signals({ seenAt: new Date(NOW - 5 * 60_000), seenCount: 1 }), NOW, config);
  const hoursAgo = seenPenalty(signals({ seenAt: new Date(NOW - 3 * HOUR), seenCount: 1 }), NOW, config);
  const yesterday = seenPenalty(signals({ seenAt: new Date(NOW - 20 * HOUR), seenCount: 1 }), NOW, config);
  const lastWeek = seenPenalty(signals({ seenAt: new Date(NOW - 120 * HOUR), seenCount: 1 }), NOW, config);
  const longAgo = seenPenalty(signals({ seenAt: new Date(NOW - 800 * HOUR), seenCount: 1 }), NOW, config);

  assert.ok(minutesAgo < hoursAgo);
  assert.ok(hoursAgo < yesterday);
  assert.ok(yesterday < lastWeek);
  assert.ok(lastWeek < longAgo);
  assert.ok(longAgo < 0, 'still a penalty');
  assert.ok(longAgo > -5, 'but a weak one, so strongly relevant old posts return');
  assert.equal(seenPenalty(signals({ seenAt: null }), NOW, config), 0);
});

test('repeat impressions deepen the penalty but are capped', () => {
  const once = seenPenalty(signals({ seenAt: new Date(NOW - 3 * HOUR), seenCount: 1 }), NOW, config);
  const thrice = seenPenalty(signals({ seenAt: new Date(NOW - 3 * HOUR), seenCount: 3 }), NOW, config);
  const many = seenPenalty(signals({ seenAt: new Date(NOW - 3 * HOUR), seenCount: 50 }), NOW, config);

  assert.ok(thrice < once);
  assert.equal(
    many,
    config.penalties.seenWithinHours + config.seen.maxCountedRepeats * config.penalties.repeatImpression
  );
});
