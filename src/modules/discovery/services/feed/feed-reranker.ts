/**
 * FeedReranker — greedy selection with soft diversity penalties and controlled
 * exploration mixing.
 *
 * Runs after scoring, over the whole ranked pool, filling one slot at a time.
 * At each slot every remaining candidate is re-scored against what has already
 * been placed, so "this creator was two posts ago" is a live cost rather than a
 * fixed rule.
 *
 * Two deliberate choices:
 *
 *   - Penalties are soft. A strongly relevant post from a repeated creator can
 *     still win a slot; it just has to be worth the repetition. Nothing relevant
 *     is deleted for diversity's sake.
 *   - Exploration is a running-share target, not a fixed position. "Every 10th
 *     post is discovery" is trivially learnable and feels mechanical; instead an
 *     exploration item is preferred whenever the realised share has fallen below
 *     target *and* it is close enough in score to the best alternative.
 */

import { getFeedConfig, SOURCE_REASON, type FeedConfig } from './feed-config';
import type { RerankedFeedItem, ScoredFeedCandidate } from './feed-types';

export interface RerankOptions {
  limit: number;
  isColdStart: boolean;
  nowMs: number;
  config?: FeedConfig;
}

interface PlacementState {
  recentAuthors: string[];
  recentTopics: string[][];
  recentColleges: Array<string | null>;
  recentSources: string[];
  authorCounts: Map<string, number>;
  sourceCounts: Map<string, number>;
  explorationPlaced: number;
  placed: number;
}

function tail<T>(values: T[], window: number): T[] {
  return window <= 0 ? [] : values.slice(-window);
}

/**
 * Cost of placing `candidate` next, given what is already on the page.
 *
 * Always <= 0. Returned separately from the base score so the debug view can
 * show exactly how much diversity moved an item.
 */
export function diversityAdjustment(
  candidate: ScoredFeedCandidate,
  state: PlacementState,
  config: FeedConfig
): number {
  const d = config.diversity;
  const p = config.penalties;
  let adjustment = 0;

  // Same creator inside the look-back window; adjacent repeats cost double.
  const recentAuthors = tail(state.recentAuthors, d.creatorWindow);
  const authorIndex = recentAuthors.lastIndexOf(candidate.authorId);
  if (authorIndex >= 0) {
    const distance = recentAuthors.length - authorIndex;
    adjustment += p.creatorRepeatedInWindow * (distance === 1 ? 1 : 0.6);
  }

  // Hard-ish ceiling on how much of one page a single creator can own.
  const authorCount = state.authorCounts.get(candidate.authorId) || 0;
  if (authorCount >= d.maxPostsPerCreatorPerPage) {
    adjustment += p.creatorRepeatedInWindow * (1 + authorCount - d.maxPostsPerCreatorPerPage);
  }

  // Topic repetition, proportional to how much of the recent window it covers.
  if (candidate.topics.length > 0) {
    const recentTopics = new Set(tail(state.recentTopics, d.topicWindow).flat());
    const overlap = candidate.topics.filter((topic) => recentTopics.has(topic)).length;
    if (overlap > 0) {
      adjustment += p.topicRepeatedInWindow * Math.min(1, overlap / candidate.topics.length);
    }
  }

  // One college should not own the feed even when its members post constantly.
  if (candidate.college) {
    const repeats = tail(state.recentColleges, d.collegeWindow).filter(
      (college) => college === candidate.college
    ).length;
    if (repeats >= 2) adjustment += p.collegeRepeatedInWindow * (repeats - 1);
  }

  // Source repetition: stops the page becoming "all following" or "all trending".
  const recentSources = tail(state.recentSources, d.sourceWindow);
  if (
    recentSources.length >= d.maxConsecutiveSameSource &&
    recentSources.every((source) => source === candidate.primarySource)
  ) {
    adjustment += p.sourceRepeatedInWindow;
  }

  const sourceCount = state.sourceCounts.get(candidate.primarySource) || 0;
  const sourceShare = state.placed > 0 ? sourceCount / state.placed : 0;
  if (state.placed >= 6 && sourceShare > d.maxSourceShare) {
    adjustment += p.sourceRepeatedInWindow * ((sourceShare - d.maxSourceShare) * 10);
  }

  return adjustment;
}

/** Target exploration share for this viewer. New users get more discovery. */
export function explorationTarget(isColdStart: boolean, config: FeedConfig): number {
  const target = isColdStart ? config.exploration.coldStartTargetShare : config.exploration.targetShare;
  return Math.min(config.exploration.maxShare, Math.max(0, target));
}

/**
 * Re-ranks the scored pool into the final ordered feed.
 *
 * The returned list is the whole ranked session (up to `limit`), not one page —
 * pagination slices it afterwards so ordering stays stable across pages.
 */
export function rerankFeed(
  scored: ScoredFeedCandidate[],
  options: RerankOptions
): RerankedFeedItem[] {
  const config = options.config || getFeedConfig();
  const limit = Math.max(0, Math.floor(options.limit));
  if (limit === 0 || scored.length === 0) return [];

  const remaining = [...scored];
  const output: RerankedFeedItem[] = [];
  const target = explorationTarget(options.isColdStart, config);

  const state: PlacementState = {
    recentAuthors: [],
    recentTopics: [],
    recentColleges: [],
    recentSources: [],
    authorCounts: new Map(),
    sourceCounts: new Map(),
    explorationPlaced: 0,
    placed: 0,
  };

  while (output.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    let bestAdjustment = 0;

    const adjustments = new Array<number>(remaining.length);
    for (let index = 0; index < remaining.length; index += 1) {
      const adjustment = diversityAdjustment(remaining[index], state, config);
      adjustments[index] = adjustment;
      const effective = remaining[index].baseScore + adjustment;
      if (effective > bestScore) {
        bestScore = effective;
        bestIndex = index;
        bestAdjustment = adjustment;
      }
    }

    // Exploration mixing. Only considered when the realised share has fallen
    // behind target, and only for an item close enough to the current best —
    // discovery earns its slot, it is never inserted at a fixed position.
    const realisedShare = state.placed > 0 ? state.explorationPlaced / state.placed : 0;
    if (realisedShare < target && !remaining[bestIndex].isExploration) {
      const tolerance = Math.abs(bestScore) * config.exploration.maxScoreGapRatio;
      let explorationIndex = -1;
      let explorationScore = -Infinity;

      for (let index = 0; index < remaining.length; index += 1) {
        if (!remaining[index].isExploration) continue;
        const effective = remaining[index].baseScore + adjustments[index];
        if (effective > explorationScore) {
          explorationScore = effective;
          explorationIndex = index;
        }
      }

      if (explorationIndex >= 0 && bestScore - explorationScore <= tolerance) {
        bestIndex = explorationIndex;
        bestScore = explorationScore;
        bestAdjustment = adjustments[explorationIndex];
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    const reason = SOURCE_REASON[chosen.primarySource];

    output.push({
      ...chosen,
      position: output.length + 1,
      finalScore: Number(bestScore.toFixed(4)),
      diversityAdjustment: Number(bestAdjustment.toFixed(4)),
      reasonCode: reason.code,
      reasonText: reason.text,
    });

    state.recentAuthors.push(chosen.authorId);
    state.recentTopics.push(chosen.topics);
    state.recentColleges.push(chosen.college);
    state.recentSources.push(chosen.primarySource);
    state.authorCounts.set(chosen.authorId, (state.authorCounts.get(chosen.authorId) || 0) + 1);
    state.sourceCounts.set(chosen.primarySource, (state.sourceCounts.get(chosen.primarySource) || 0) + 1);
    state.placed += 1;
    if (chosen.isExploration) state.explorationPlaced += 1;
  }

  return output;
}

/** Share of the produced feed that came from exploration sources. */
export function explorationShare(items: RerankedFeedItem[]): number {
  if (items.length === 0) return 0;
  return items.filter((item) => item.isExploration).length / items.length;
}
