/**
 * RelationshipScorer — a reusable 0..1 affinity score between the viewer and
 * another user.
 *
 * Deliberately pure and dependency-free so the same score can back People You
 * May Know, Crossed Paths, connection suggestions, messaging suggestions,
 * notification targeting and search ranking without any of them re-deriving
 * "how close are these two people".
 *
 * Recent interactions outweigh old ones: every count-based signal is supplied
 * already time-decayed by the caller (see `decayedCount`), and the raw counts
 * saturate so one very chatty peer cannot dominate the score.
 */

import { getFeedConfig, type FeedRelationshipConfig } from './feed-config';

export interface RelationshipInput {
  isFollowing?: boolean;
  isFollowedBy?: boolean;
  isConnection?: boolean;
  /** Connection accepted inside `recentConnectionDays`. */
  isRecentConnection?: boolean;
  connectionAgeDays?: number | null;
  lastInteractionAt?: Date | string | number | null;

  messagesCount?: number;
  commentsBetweenUsers?: number;
  likesBetweenUsers?: number;
  profileVisits?: number;

  sameCollege?: boolean;
  sharedInterestsCount?: number;
  sharedSkillsCount?: number;
  viewerInterestsCount?: number;
  viewerSkillsCount?: number;
}

export interface RelationshipBreakdown {
  score: number;
  components: Record<string, number>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Saturating transform: 0 stays 0, `saturation` maps to ~0.63, and growth beyond
 * that is strongly diminishing. Chosen over a hard `min(x/s, 1)` so that the
 * difference between 1 and 2 interactions still registers.
 */
export function saturate(count: number, saturation: number): number {
  const safeCount = Math.max(0, Number(count) || 0);
  const safeSaturation = Math.max(1, Number(saturation) || 1);
  return clamp01(1 - Math.exp(-safeCount / safeSaturation));
}

/**
 * Exponential recency decay for an interaction count.
 *
 * Callers that only have "N interactions, most recent at T" use this to express
 * "N interactions, but they were all six months ago".
 */
export function decayedCount(
  count: number,
  lastAt: Date | string | number | null | undefined,
  halfLifeDays: number,
  nowMs: number = Date.now()
): number {
  const safeCount = Math.max(0, Number(count) || 0);
  if (safeCount === 0) return 0;
  if (!lastAt) return safeCount;

  const lastMs = new Date(lastAt as never).getTime();
  if (!Number.isFinite(lastMs)) return safeCount;

  const ageDays = Math.max(0, nowMs - lastMs) / 86_400_000;
  const halfLife = Math.max(0.5, halfLifeDays);
  return safeCount * Math.pow(0.5, ageDays / halfLife);
}

/**
 * Ratio of shared attributes, normalised by how many the viewer has.
 *
 * A raw count would rank a user with 40 interests above one with 3 for every
 * viewer; normalising asks "what fraction of what I care about do we share".
 */
export function sharedRatio(sharedCount: number, viewerCount: number): number {
  const shared = Math.max(0, Number(sharedCount) || 0);
  const total = Math.max(0, Number(viewerCount) || 0);
  if (shared === 0) return 0;
  if (total === 0) return clamp01(shared / 3);
  // Small overlaps on a large profile should still count for something, so the
  // denominator is capped rather than being the full profile size.
  return clamp01(shared / Math.min(total, 6));
}

export function scoreRelationship(
  input: RelationshipInput,
  config: FeedRelationshipConfig = getFeedConfig().relationship
): RelationshipBreakdown {
  const w = config.weights;
  const s = config.saturation;

  const components: Record<string, number> = {
    following: input.isFollowing ? w.following : 0,
    connection: input.isConnection ? w.connection : 0,
    mutualFollow: input.isFollowing && input.isFollowedBy ? w.mutualFollow : 0,
    recentConnection: input.isRecentConnection ? w.recentConnection : 0,
    messages: w.messages * saturate(input.messagesCount || 0, s.messages),
    comments: w.comments * saturate(input.commentsBetweenUsers || 0, s.comments),
    likes: w.likes * saturate(input.likesBetweenUsers || 0, s.likes),
    profileVisits: w.profileVisits * saturate(input.profileVisits || 0, s.profileVisits),
    sharedCollege: input.sameCollege ? w.sharedCollege : 0,
    sharedInterests:
      w.sharedInterests * sharedRatio(input.sharedInterestsCount || 0, input.viewerInterestsCount || 0),
    sharedSkills:
      w.sharedSkills * sharedRatio(input.sharedSkillsCount || 0, input.viewerSkillsCount || 0),
  };

  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { score: clamp01(total), components };
}

/** Convenience wrapper for callers that only want the number. */
export function relationshipStrength(
  input: RelationshipInput,
  config?: FeedRelationshipConfig
): number {
  return scoreRelationship(input, config).score;
}
