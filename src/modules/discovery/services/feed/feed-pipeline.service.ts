/**
 * The home feed pipeline.
 *
 * Candidate generation → eligibility → signals → ranking → re-ranking.
 * Pagination, impression tracking and hydration sit outside this module so the
 * ranking stages stay independently testable and independently replaceable: a
 * learned ranker only has to satisfy the same `ScoredFeedCandidate` contract.
 *
 * The pipeline never throws for data reasons. Any stage that fails degrades the
 * result (and sets `degraded`), and an empty result tells the caller to fall
 * back to the legacy ranker rather than serve an empty feed.
 */

import { getFeedConfig, type FeedConfig } from './feed-config';
import { generateCandidates } from './candidate-generators';
import { excludedAuthorIds, filterEligibleCandidates, loadEligibilityContext } from './feed-eligibility.service';
import { computeSignals, loadSignalInputs } from './feed-signals.service';
import { rankCandidate, sortScoredCandidates } from './feed-ranker';
import { explorationShare, rerankFeed } from './feed-reranker';
import { loadFeedViewerContext } from './feed-viewer-context.service';
import type { FeedDebugEntry, FeedPipelineResult, FeedViewerContext, ScoredFeedCandidate } from './feed-types';

export interface BuildFeedInput {
  userId: string;
  /** Total ranked items to produce. Defaults to the configured session size. */
  sessionSize?: number;
  nowMs?: number;
  config?: FeedConfig;
  /** Pre-loaded viewer context, if the caller already has one. */
  viewer?: FeedViewerContext;
}

export interface BuildFeedOutput extends FeedPipelineResult {
  viewer: FeedViewerContext;
  removedCounts: Record<string, number>;
  failedSources: string[];
  timings: Record<string, number>;
}

/**
 * Stable percentage rollout.
 *
 * Hash-based so a given user is always on the same side of the split — a viewer
 * whose feed flips between two rankers on every request would see exactly the
 * "same posts / different posts" churn this work exists to fix.
 */
export function isFeedV2Enabled(userId: string, config: FeedConfig = getFeedConfig()): boolean {
  if (!config.enabled) return false;
  if (config.rolloutPercent >= 100) return true;
  if (config.rolloutPercent <= 0) return false;

  let hash = 2166136261;
  const key = `feed-v2:${userId}`;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 100) < config.rolloutPercent;
}

export async function buildPersonalizedFeed(input: BuildFeedInput): Promise<BuildFeedOutput> {
  const config = input.config || getFeedConfig();
  const nowMs = input.nowMs ?? Date.now();
  const sessionSize = Math.max(1, input.sessionSize ?? config.pagination.sessionSize);
  const timings: Record<string, number> = {};
  let degraded = false;

  const stage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      timings[name] = Date.now() - startedAt;
    }
  };

  const [viewer, eligibility] = await stage('context', () =>
    Promise.all([
      input.viewer ? Promise.resolve(input.viewer) : loadFeedViewerContext(input.userId, nowMs),
      loadEligibilityContext(input.userId, nowMs),
    ])
  );

  const generated = await stage('candidates', () =>
    generateCandidates({
      viewer,
      excludedAuthorIds: excludedAuthorIds(eligibility),
      nowMs,
      config,
    })
  );
  if (generated.failedSources.length > 0) degraded = true;

  const { eligible, removed } = filterEligibleCandidates(generated.candidates.values(), eligibility, {
    nowMs,
    maxAgeHours: config.freshness.maxAgeHours,
  });

  const emptyResult: BuildFeedOutput = {
    items: [],
    rankingVersion: config.rankingVersion,
    candidateCount: generated.candidates.size,
    eligibleCount: eligible.length,
    sourceCounts: generated.sourceCounts,
    explorationShare: 0,
    coldStart: viewer.isColdStart,
    degraded: true,
    viewer,
    removedCounts: removed,
    failedSources: generated.failedSources,
    timings,
  };

  if (eligible.length === 0) return emptyResult;

  const bundle = await stage('signals', () =>
    loadSignalInputs({ userId: input.userId, candidates: eligible, nowMs, config })
  );

  // `bundle.posts` only contains posts that survived the authoritative
  // visibility gate, so iterating it (rather than `eligible`) is what guarantees
  // no unauthorised post can reach ranking.
  const scored: ScoredFeedCandidate[] = [];
  for (const candidate of eligible) {
    const post = bundle.posts.get(candidate.postId);
    if (!post) continue;

    const author = bundle.authors.get(candidate.authorId);
    if (author?.isBanned) continue;

    const signals = computeSignals({
      candidate,
      post,
      author,
      viewer,
      seen: bundle.seen.get(candidate.postId),
      behaviour: bundle.creatorBehaviour.get(candidate.authorId),
      stats: bundle.stats.get(candidate.postId),
      authorRecentPostCount: bundle.authorPostCounts.get(candidate.authorId) || 0,
      nowMs,
      config,
    });

    scored.push(rankCandidate({ candidate, post, author, signals, viewer, nowMs, config }));
  }

  if (scored.length === 0) return { ...emptyResult, eligibleCount: eligible.length };

  const items = rerankFeed(sortScoredCandidates(scored), {
    limit: Math.min(sessionSize, scored.length),
    isColdStart: viewer.isColdStart,
    nowMs,
    config,
  });

  return {
    items,
    rankingVersion: config.rankingVersion,
    candidateCount: generated.candidates.size,
    eligibleCount: scored.length,
    sourceCounts: generated.sourceCounts,
    explorationShare: explorationShare(items),
    coldStart: viewer.isColdStart,
    degraded,
    viewer,
    removedCounts: removed,
    failedSources: generated.failedSources,
    timings,
  };
}

/**
 * Developer-only explain payload.
 *
 * Callers must gate this behind `isFeedDebugAllowed()` plus an admin check — it
 * exposes another user's relationship and affinity values, which are private.
 */
export function buildFeedDebugEntries(output: BuildFeedOutput, limit = 50): FeedDebugEntry[] {
  return output.items.slice(0, limit).map((item) => ({
    postId: item.postId,
    authorId: item.authorId,
    position: item.position,
    finalScore: item.finalScore,
    baseScore: item.baseScore,
    diversityAdjustment: item.diversityAdjustment,
    primarySource: item.primarySource,
    candidateSources: item.sources,
    breakdown: item.breakdown,
    signals: item.signals,
  }));
}
