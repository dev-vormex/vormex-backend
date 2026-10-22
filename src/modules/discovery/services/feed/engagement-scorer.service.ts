/**
 * EngagementScorer — turns raw interaction counters into reach-normalised,
 * sample-size-aware quality signals.
 *
 * Three rules drive everything here:
 *   1. Absolute likes never rank anything. A post with 500 likes from 50k
 *      impressions is worse than one with 20 likes from 300.
 *   2. Small samples are pulled toward the platform prior, so a 1-like/
 *      1-impression post cannot outrank a proven one on rate alone.
 *   3. Interaction types are weighted by how much intent they express: a save or
 *      a share says far more than a like, and a connection made after seeing a
 *      post is the strongest signal Vormex has.
 */

import { getFeedConfig, type FeedEngagementConfig } from './feed-config';

export interface EngagementCounts {
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  profileVisits?: number;
  connections?: number;
}

export interface EngagementQualityInput extends EngagementCounts {
  /** Recorded impressions. 0 means "unknown", not "nobody saw it". */
  impressions?: number;
  uniqueEngagers?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function count(value: number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Intent-weighted total of every interaction on a post. */
export function weightedEngagement(
  counts: EngagementCounts,
  config: FeedEngagementConfig = getFeedConfig().engagement
): number {
  const w = config.weights;
  return (
    count(counts.likes) * w.like +
    count(counts.comments) * w.comment +
    count(counts.saves) * w.save +
    count(counts.shares) * w.share +
    count(counts.profileVisits) * w.profileVisit +
    count(counts.connections) * w.connection
  );
}

/**
 * Effective reach for rate calculations.
 *
 * Impression tracking is best-effort (clients can drop batches, older posts
 * predate it), so when impressions look implausibly low next to the interaction
 * count we fall back to the interaction count itself. That keeps the rate
 * bounded instead of letting a missing denominator produce a rate of 5.0.
 */
export function effectiveReach(
  input: EngagementQualityInput,
  config: FeedEngagementConfig = getFeedConfig().engagement
): number {
  const rawInteractions =
    count(input.likes) + count(input.comments) + count(input.saves) + count(input.shares);
  return Math.max(count(input.impressions), rawInteractions, config.minimumReach);
}

/**
 * Bayesian-smoothed weighted engagement rate, then squashed to 0..1.
 *
 * `priorMass` pseudo-impressions at `priorRate` are blended in, so confidence
 * grows with evidence rather than jumping on the first interaction.
 */
export function engagementQuality(
  input: EngagementQualityInput,
  config: FeedEngagementConfig = getFeedConfig().engagement
): number {
  const reach = effectiveReach(input, config);
  const engagement = weightedEngagement(input, config);

  const smoothedRate =
    (engagement + config.priorMass * config.priorRate) / (reach + config.priorMass);

  const normalized = clamp01(smoothedRate / Math.max(0.0001, config.saturationRate));

  // Engagement concentrated in very few accounts is weak evidence and is exactly
  // what a like ring produces, so discount it until enough distinct people act.
  const engagers = count(input.uniqueEngagers);
  if (engagers > 0 && engagers < config.minimumUniqueEngagers) {
    return normalized * (engagers / config.minimumUniqueEngagers);
  }

  return normalized;
}

/** Raw rate, unsquashed. Exposed for debug output and metrics. */
export function weightedEngagementRate(
  input: EngagementQualityInput,
  config: FeedEngagementConfig = getFeedConfig().engagement
): number {
  return weightedEngagement(input, config) / effectiveReach(input, config);
}

/**
 * Trending velocity: intent-weighted engagement per hour inside the rolling
 * window, normalised to 0..1.
 *
 * Uses the rolling window rather than lifetime counters, so nothing trends
 * forever — a post that was huge last month scores zero here today.
 */
export function engagementVelocity(
  input: { recentEngagement?: number; ageHours: number },
  config: FeedEngagementConfig = getFeedConfig().engagement
): number {
  const recent = count(input.recentEngagement);
  if (recent === 0) return 0;

  // A three-hour-old post has only had three hours to collect its window, so
  // dividing by the full window would systematically punish new posts.
  const hours = Math.max(1, Math.min(config.velocityWindowHours, input.ageHours || 0));
  const perHour = recent / hours;
  return clamp01(perHour / Math.max(0.0001, config.velocitySaturation));
}

/**
 * Trending score for the trending candidate pool: velocity, discounted by age so
 * a stale post cannot hold a trending slot, and by unique engagers so a burst
 * from a handful of accounts does not qualify.
 */
export function trendingScore(
  input: { recentEngagement?: number; uniqueEngagers?: number; ageHours: number },
  config: FeedEngagementConfig = getFeedConfig().engagement
): number {
  const velocity = engagementVelocity(input, config);
  if (velocity === 0) return 0;

  const engagers = count(input.uniqueEngagers);
  const breadth =
    engagers >= config.minimumUniqueEngagers
      ? 1
      : Math.max(0, engagers) / config.minimumUniqueEngagers;

  const ageDecay = Math.pow(0.5, Math.max(0, input.ageHours) / config.velocityWindowHours);
  return clamp01(velocity * breadth * ageDecay);
}
