import { createHash } from 'crypto';

export type RecommendationSurface = 'HOME' | 'REELS' | 'STORIES' | 'PEOPLE' | 'JOBS' | 'EVENTS';
export type RecommendationEntityType = 'POST' | 'REEL' | 'STORY' | 'PERSON' | 'JOB' | 'EVENT';
export type RecommendationSource =
  | 'NETWORK'
  | 'NETWORK_ENGAGED'
  | 'SEMANTIC'
  | 'COHORT_TRENDING'
  | 'EXPLORATION';

export interface RecommendationFeaturePriors {
  semantic: number;
  relationship: number;
  socialProof: number;
  quality: number;
  freshness: number;
  exploration: number;
  cohortFit: number;
}

export interface RecommendationCandidate<T = unknown> {
  id: string;
  entityType: RecommendationEntityType;
  authorId?: string | null;
  value: T;
  sources: RecommendationSource[];
  features: Partial<RecommendationFeaturePriors>;
  negativeFeedbackRate?: number | null;
  organicImpressions?: number;
  seenAt?: Date | string | null;
  meaningfulActivityAt?: Date | string | null;
  premiumTieBreak?: number;
  learnedUtility?: number;
  socialActors?: Array<{ id: string; name: string; profileImage?: string | null }>;
  score?: number;
  primarySource?: RecommendationSource;
}

export interface RankedRecommendation<T = unknown> extends RecommendationCandidate<T> {
  score: number;
  primarySource: RecommendationSource;
  reasonCode: string;
  reasonText: string;
  position: number;
  examinationPropensity?: number;
}

export const RECOMMENDATION_RANKER_VERSION = process.env.RECOMMENDATION_RANKER_VERSION || 'vormex-unified-v1';

export const DEFAULT_FEATURE_PRIORS: RecommendationFeaturePriors = {
  semantic: 0.5,
  relationship: 0.25,
  socialProof: 0.25,
  quality: 0.5,
  freshness: 0.5,
  exploration: 0.5,
  cohortFit: 0.25,
};

export const FEATURE_WEIGHTS: RecommendationFeaturePriors = {
  semantic: 0.28,
  relationship: 0.22,
  socialProof: 0.16,
  quality: 0.14,
  freshness: 0.10,
  exploration: 0.05,
  cohortFit: 0.05,
};

export const SOURCE_SHARES: Record<RecommendationSource, number> = {
  NETWORK: 0.30,
  NETWORK_ENGAGED: 0.25,
  SEMANTIC: 0.20,
  COHORT_TRENDING: 0.15,
  EXPLORATION: 0.10,
};

const SOURCE_ORDER = Object.keys(SOURCE_SHARES) as RecommendationSource[];
const SOURCE_REASON: Record<RecommendationSource, { code: string; text: string }> = {
  NETWORK: { code: 'IN_YOUR_NETWORK', text: 'From someone in your network' },
  NETWORK_ENGAGED: { code: 'NETWORK_FOUND_USEFUL', text: 'People in your network found this useful' },
  SEMANTIC: { code: 'MATCHES_INTERESTS', text: 'Matches your skills and interests' },
  COHORT_TRENDING: { code: 'TRENDING_IN_COHORT', text: 'Relevant in your campus or cohort' },
  EXPLORATION: { code: 'NEW_FOR_YOU', text: 'Something new for you' },
};

function clamp01(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function validDateMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function stableUnitInterval(value: string): number {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function assignRecommendationVariant(userId: string): 'control' | 'treatment' | 'training_exploration' {
  if (process.env.RECOMMENDATION_POSITION_EXPLORATION_ENABLED === 'true') {
    const explorationShare = clamp01(process.env.RECOMMENDATION_POSITION_EXPLORATION_SHARE || 0.05);
    if (stableUnitInterval(`position:${userId}`) < explorationShare) return 'training_exploration';
  }

  if (process.env.RECOMMENDATION_TREATMENT_ENABLED !== 'true') return 'control';
  const share = clamp01(process.env.RECOMMENDATION_TREATMENT_SHARE || 0.05);
  return stableUnitInterval(`treatment:${userId}`) < share ? 'treatment' : 'control';
}

export function freshnessScore(createdAt: Date | string, halfLifeHours: number, nowMs = Date.now()): number {
  const createdMs = validDateMs(createdAt) ?? nowMs;
  const ageHours = Math.max(0, nowMs - createdMs) / 3_600_000;
  return clamp01(Math.pow(0.5, ageHours / Math.max(1, halfLifeHours)));
}

export function scoreRecommendationCandidate(
  candidate: RecommendationCandidate,
  priors: RecommendationFeaturePriors = DEFAULT_FEATURE_PRIORS
): number {
  const feature = (key: keyof RecommendationFeaturePriors): number => {
    const value = candidate.features[key];
    return value === undefined || value === null || !Number.isFinite(Number(value))
      ? clamp01(priors[key])
      : clamp01(value);
  };

  const heuristic = (Object.keys(FEATURE_WEIGHTS) as Array<keyof RecommendationFeaturePriors>)
    .reduce((total, key) => total + FEATURE_WEIGHTS[key] * feature(key), 0);
  const base = candidate.learnedUtility === undefined
    ? heuristic
    : 0.70 * clamp01(candidate.learnedUtility) + 0.30 * heuristic;
  const tieBreak = Math.min(0.02, Math.max(0, Number(candidate.premiumTieBreak || 0)));
  return Number((base + tieBreak).toFixed(8));
}

export function sourceQuotaCounts(limit = 500): Record<RecommendationSource, number> {
  const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
  const output = {} as Record<RecommendationSource, number>;
  let assigned = 0;
  SOURCE_ORDER.forEach((source, index) => {
    const count = index === SOURCE_ORDER.length - 1
      ? bounded - assigned
      : Math.floor(bounded * SOURCE_SHARES[source]);
    output[source] = count;
    assigned += count;
  });
  return output;
}

export function allocateCandidateSources<T>(
  input: RecommendationCandidate<T>[],
  limit = 500,
  priors: RecommendationFeaturePriors = DEFAULT_FEATURE_PRIORS
): Array<RecommendationCandidate<T> & { score: number; primarySource: RecommendationSource }> {
  const quotas = sourceQuotaCounts(limit);
  const candidates = input
    .filter((candidate, index, all) => Boolean(candidate.id) && all.findIndex((item) => item.id === candidate.id) === index)
    .filter((candidate) => (candidate.sources || []).length > 0)
    .filter((candidate) => !(
      Number(candidate.organicImpressions || 0) >= 100 &&
      Number(candidate.negativeFeedbackRate || 0) > 0.03
    ))
    .map((candidate) => ({ ...candidate, score: scoreRecommendationCandidate(candidate, priors) }));

  const selected = new Map<string, RecommendationCandidate<T> & { score: number; primarySource: RecommendationSource }>();
  for (const source of SOURCE_ORDER) {
    const sourceCandidates = candidates
      .filter((candidate) => candidate.sources.includes(source) && !selected.has(candidate.id))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    for (const candidate of sourceCandidates.slice(0, quotas[source])) {
      selected.set(candidate.id, { ...candidate, primarySource: source });
    }
  }

  const targetSize = Math.min(limit, candidates.length);
  while (selected.size < targetSize) {
    const availableSources = SOURCE_ORDER.filter((source) =>
      candidates.some((candidate) => candidate.sources.includes(source) && !selected.has(candidate.id))
    );
    if (availableSources.length === 0) break;

    const remainingSlots = targetSize - selected.size;
    const remainingShare = availableSources.reduce((total, source) => total + SOURCE_SHARES[source], 0);
    let madeProgress = false;
    for (const source of availableSources) {
      const proportionalShare = SOURCE_SHARES[source] / remainingShare;
      const sourceAllowance = Math.max(1, Math.floor(remainingSlots * proportionalShare));
      const sourceCandidates = candidates
        .filter((candidate) => candidate.sources.includes(source) && !selected.has(candidate.id))
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      for (const candidate of sourceCandidates.slice(0, sourceAllowance)) {
        selected.set(candidate.id, { ...candidate, primarySource: source });
        madeProgress = true;
        if (selected.size >= targetSize) break;
      }
      if (selected.size >= targetSize) break;
    }
    if (!madeProgress) break;
  }

  return Array.from(selected.values()).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function suppressRecentlyViewed<T>(
  input: Array<RecommendationCandidate<T> & { score: number; primarySource: RecommendationSource }>,
  nowMs = Date.now(),
  minimumInventory = 60
): Array<RecommendationCandidate<T> & { score: number; primarySource: RecommendationSource }> {
  const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  const eligible: typeof input = [];
  const suppressed: typeof input = [];

  for (const candidate of input) {
    const seenMs = validDateMs(candidate.seenAt);
    const activityMs = validDateMs(candidate.meaningfulActivityAt);
    if (seenMs !== null && seenMs >= cutoff && !(activityMs !== null && activityMs > seenMs)) {
      suppressed.push(candidate);
    } else {
      eligible.push(candidate);
    }
  }

  if (eligible.length >= minimumInventory || suppressed.length === 0) return eligible;
  const restoreCount = Math.min(suppressed.length, minimumInventory - eligible.length);
  const restored = suppressed
    .sort((left, right) => (validDateMs(left.seenAt) || 0) - (validDateMs(right.seenAt) || 0))
    .slice(0, restoreCount);
  return [...eligible, ...restored].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function canPlace<T>(candidate: RecommendationCandidate<T>, output: RecommendationCandidate<T>[]): boolean {
  const authorId = String(candidate.authorId || '');
  if (!authorId) return true;
  const previousAuthor = String(output[output.length - 1]?.authorId || '');
  if (previousAuthor === authorId) return false;
  if (output.length < 20) {
    const count = output.filter((item) => String(item.authorId || '') === authorId).length;
    if (count >= 2) return false;
  }
  return true;
}

function constrainedOrder<T>(
  ranked: Array<RecommendationCandidate<T> & { score: number; primarySource: RecommendationSource }>
): Array<RecommendationCandidate<T> & { score: number; primarySource: RecommendationSource }> {
  const remaining = [...ranked];
  const output: typeof ranked = [];
  const directTarget = Math.min(6, remaining.filter((item) => item.primarySource === 'NETWORK').length);
  const explorationTarget = Math.min(2, remaining.filter((item) => item.primarySource === 'EXPLORATION').length);

  while (remaining.length > 0) {
    const firstTwenty = output.length < 20;
    const directPlaced = output.filter((item) => item.primarySource === 'NETWORK').length;
    const explorationPlaced = output.filter((item) => item.primarySource === 'EXPLORATION').length;
    const slotsLeft = 20 - output.length;
    const needDirect = firstTwenty && directPlaced < directTarget && directTarget - directPlaced >= slotsLeft;
    const explorationSlot = firstTwenty && explorationPlaced < explorationTarget && [5, 14].includes(output.length);

    let index = remaining.findIndex((item) =>
      canPlace(item, output) &&
      (!needDirect || item.primarySource === 'NETWORK') &&
      (!explorationSlot || item.primarySource === 'EXPLORATION')
    );
    if (index < 0 && (needDirect || explorationSlot)) {
      index = remaining.findIndex((item) => canPlace(item, output));
    }
    // Diversity is a hard serving rule. If the remaining inventory cannot be
    // placed without an adjacent author or first-20 author overflow, return a
    // shorter page instead of padding it with a forbidden item.
    if (index < 0) break;
    output.push(remaining.splice(index, 1)[0]);
  }

  return output;
}

export function rankRecommendationCandidates<T>(
  candidates: RecommendationCandidate<T>[],
  options: { limit?: number; priors?: RecommendationFeaturePriors; nowMs?: number; applySeenSuppression?: boolean } = {}
): RankedRecommendation<T>[] {
  const allocated = allocateCandidateSources(candidates, options.limit || 500, options.priors);
  const visible = options.applySeenSuppression === false
    ? allocated
    : suppressRecentlyViewed(allocated, options.nowMs);
  return constrainedOrder(visible).map((candidate, index) => {
    const reason = SOURCE_REASON[candidate.primarySource];
    return {
      ...candidate,
      position: index + 1,
      reasonCode: reason.code,
      reasonText: reason.text,
    };
  });
}

export function applyConstrainedPositionExploration<T>(
  ranked: RankedRecommendation<T>[],
  sessionSeed: string,
  maxScoreDelta = 0.05
): RankedRecommendation<T>[] {
  const output = ranked.map((item) => ({ ...item, examinationPropensity: 1 }));
  for (let index = 2; index < output.length - 1; index += 2) {
    const left = output[index];
    const right = output[index + 1];
    if (!left || !right || Math.abs(left.score - right.score) > maxScoreDelta) continue;
    if (left.authorId && left.authorId === right.authorId) continue;
    const before = output[index - 1];
    const after = output[index + 2];
    if (right.authorId && right.authorId === before?.authorId) continue;
    if (left.authorId && left.authorId === after?.authorId) continue;
    const shouldSwap = stableUnitInterval(`${sessionSeed}:${index}:${left.id}:${right.id}`) < 0.5;
    left.examinationPropensity = 0.5;
    right.examinationPropensity = 0.5;
    if (shouldSwap) [output[index], output[index + 1]] = [right, left];
  }
  return output.map((item, index) => ({ ...item, position: index + 1 }));
}

export function qualifiesExposure(input: {
  surface: RecommendationSurface;
  maxVisibleFraction?: number | null;
  visibleTimeMs?: number | null;
  playbackTimeMs?: number | null;
  mediaDurationMs?: number | null;
}): boolean {
  const visibleFraction = clamp01(input.maxVisibleFraction || 0);
  const visibleTimeMs = Math.max(0, Number(input.visibleTimeMs || 0));
  if (input.surface === 'REELS') {
    if (visibleFraction < 0.5) return false;
    const duration = Math.max(0, Number(input.mediaDurationMs || 0));
    const required = Math.max(3_000, duration * 0.25);
    return Math.max(0, Number(input.playbackTimeMs || 0)) >= required;
  }
  if (input.surface === 'STORIES') return visibleFraction >= 0.5 && visibleTimeMs >= 2_000;
  return visibleFraction >= 0.5 && visibleTimeMs >= 1_000;
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.99999999999980993;
  const z = value - 1;
  coefficients.forEach((coefficient, index) => { x += coefficient / (z + index + 1); });
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const floor = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const m2 = 2 * iteration;
    let aa = (iteration * (b - iteration) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    result *= d * c;
    aa = -((a + iteration) * (qab + iteration) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return result;
}

export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (a <= 0 || b <= 0) throw new Error('Beta parameters must be positive');
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function betaProbabilityAboveBaseline(successes: number, failures: number, baseline: number, priorEss = 20): number {
  const boundedBaseline = Math.min(0.999999, Math.max(0.000001, baseline));
  const alpha = boundedBaseline * priorEss + Math.max(0, successes);
  const beta = (1 - boundedBaseline) * priorEss + Math.max(0, failures);
  return 1 - regularizedIncompleteBeta(boundedBaseline, alpha, beta);
}

export interface CascadeDecision {
  action: 'HOLD' | 'EXPAND_TO_75' | 'EXPAND_COHORT_BATCH' | 'STOP';
  maximumAdditionalViewers: number;
  reason: string;
  probabilityAboveBaseline: number;
  probabilityBelowBaseline: number;
}

export function evaluateCascadeGate(input: {
  qualifiedImpressions: number;
  cascadeEngagements: number;
  meaningfulOutcomes?: number;
  independentReactors: number;
  releasedViewerCount?: number;
  previousWaveSize?: number;
  baseline: number;
  meaningfulBaseline?: number;
  negativeFeedbackCount?: number;
  safetyBlocked?: boolean;
  freshnessExpired?: boolean;
  trailingWeightedSuccesses?: number;
  trailingWeightedFailures?: number;
}): CascadeDecision {
  const successes = Math.max(0, input.cascadeEngagements);
  const failures = Math.max(0, input.qualifiedImpressions - successes);
  const probabilityAbove = betaProbabilityAboveBaseline(successes, failures, input.baseline);
  const trailingSuccesses = input.trailingWeightedSuccesses ?? successes;
  const trailingFailures = input.trailingWeightedFailures ?? failures;
  const probabilityBelow = 1 - betaProbabilityAboveBaseline(trailingSuccesses, trailingFailures, input.baseline);
  const negativeRate = input.qualifiedImpressions > 0
    ? Number(input.negativeFeedbackCount || 0) / input.qualifiedImpressions
    : 0;

  if (input.safetyBlocked || input.freshnessExpired) {
    return { action: 'STOP', maximumAdditionalViewers: 0, reason: input.safetyBlocked ? 'SAFETY' : 'FRESHNESS', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
  }
  if (input.qualifiedImpressions >= 100 && negativeRate > 0.03) {
    return { action: 'STOP', maximumAdditionalViewers: 0, reason: 'NEGATIVE_FEEDBACK', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
  }
  if (probabilityBelow >= 0.90) {
    return { action: 'STOP', maximumAdditionalViewers: 0, reason: 'UNDERPERFORMING', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
  }
  if (input.qualifiedImpressions >= 20 && input.qualifiedImpressions < 75 && probabilityAbove >= 0.70) {
    const waveCap = Math.max(0, Math.floor((input.previousWaveSize || 20) * 5));
    return { action: 'EXPAND_TO_75', maximumAdditionalViewers: Math.min(55, waveCap), reason: 'POSTERIOR_70', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
  }
  if (input.qualifiedImpressions >= 75 && input.independentReactors >= 3 && probabilityAbove >= 0.80) {
    if (input.qualifiedImpressions >= 500) {
      const meaningful = Math.max(0, input.meaningfulOutcomes || 0);
      const meaningfulProbability = betaProbabilityAboveBaseline(
        meaningful,
        Math.max(0, input.qualifiedImpressions - meaningful),
        input.meaningfulBaseline || 0.01
      );
      if (meaningfulProbability < 0.5) {
        return { action: 'HOLD', maximumAdditionalViewers: 0, reason: 'MEANINGFUL_OUTCOME_GATE', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
      }
    }
    return { action: 'EXPAND_COHORT_BATCH', maximumAdditionalViewers: 500, reason: 'POSTERIOR_80', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
  }
  return { action: 'HOLD', maximumAdditionalViewers: 0, reason: 'INSUFFICIENT_EVIDENCE', probabilityAboveBaseline: probabilityAbove, probabilityBelowBaseline: probabilityBelow };
}

export function learnedUtility(input: {
  useful?: number | null;
  qualityDwell?: number | null;
  skip?: number | null;
  negative?: number | null;
}, priors: Required<typeof input>): number {
  const value = (key: keyof typeof input) => clamp01(input[key] ?? priors[key]);
  return clamp01(
    0.40 * value('useful') +
    0.25 * value('qualityDwell') +
    0.20 * (1 - value('skip')) +
    0.15 * (1 - value('negative'))
  );
}

export function inversePropensityWeight(propensity: number, normalizer = 1): number {
  const safe = Math.max(0.0001, Number(propensity || 0));
  return Math.min(10, (1 / safe) / Math.max(0.0001, normalizer));
}
