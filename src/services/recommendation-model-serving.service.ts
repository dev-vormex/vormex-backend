import { Prisma } from '@prisma/client';
import { prismaRead } from '../config/prisma';
import {
  learnedUtility,
  RECOMMENDATION_RANKER_VERSION,
  type RecommendationFeaturePriors,
  type RecommendationSurface,
} from './recommendation-engine.service';

const FEATURE_NAMES = ['semantic', 'relationship', 'socialProof', 'quality', 'freshness', 'exploration', 'cohortFit'] as const;
const DEFAULT_FEATURE_PRIORS: RecommendationFeaturePriors = {
  semantic: 0.35,
  relationship: 0.25,
  socialProof: 0.2,
  quality: 0.5,
  freshness: 0.5,
  exploration: 0.5,
  cohortFit: 0.3,
};
const DEFAULT_HEAD_PRIORS = { useful: 0.02, qualityDwell: 0.08, skip: 0.5, negative: 0.01 };

interface LogisticHead {
  intercept: number;
  coefficients: number[];
  prior: number;
}

export interface RecommendationModelBundle {
  featurePriors: RecommendationFeaturePriors;
  learnedUtilityFor(features: Record<string, number | null | undefined>): number | undefined;
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

export async function loadRecommendationModelBundle(
  surface: RecommendationSurface
): Promise<RecommendationModelBundle> {
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT "head", "coefficients", "priors" FROM "recommendation_models"
    WHERE "surface" = ${surface}
      AND (("head" = 'heuristic' AND "version" = ${RECOMMENDATION_RANKER_VERSION})
        OR ("head" IN ('useful', 'quality_dwell', 'skip', 'negative_feedback') AND "status" = 'active'))
    ORDER BY "activatedAt" DESC NULLS LAST, "createdAt" DESC
  `).catch(() => []);
  const heuristic = rows.find((row) => row.head === 'heuristic');
  const storedPriors = heuristic?.priors && typeof heuristic.priors === 'object' ? heuristic.priors : {};
  const featurePriors = { ...DEFAULT_FEATURE_PRIORS, ...storedPriors };
  const heads = new Map<string, LogisticHead>();
  for (const row of rows) {
    if (row.head === 'heuristic' || heads.has(row.head)) continue;
    const coefficients = row.coefficients && typeof row.coefficients === 'object' ? row.coefficients : {};
    heads.set(String(row.head), {
      intercept: Number(coefficients.intercept || 0),
      coefficients: Array.isArray(coefficients.values) ? coefficients.values.map(Number) : [],
      prior: Math.min(1, Math.max(0, Number(row.priors?.positiveRate ?? 0.5))),
    });
  }

  return {
    featurePriors,
    learnedUtilityFor(features) {
      if (heads.size === 0) return undefined;
      const vector = FEATURE_NAMES.map((name) => {
        const value = features[name];
        return Math.min(1, Math.max(0, Number(value ?? featurePriors[name])));
      });
      const predict = (headName: string, fallback: number): number => {
        const head = heads.get(headName);
        if (!head) return fallback;
        return sigmoid(head.intercept + vector.reduce(
          (total, value, index) => total + value * Number(head.coefficients[index] || 0),
          0
        ));
      };
      return learnedUtility({
        useful: predict('useful', DEFAULT_HEAD_PRIORS.useful),
        qualityDwell: predict('quality_dwell', DEFAULT_HEAD_PRIORS.qualityDwell),
        skip: predict('skip', DEFAULT_HEAD_PRIORS.skip),
        negative: predict('negative_feedback', DEFAULT_HEAD_PRIORS.negative),
      }, DEFAULT_HEAD_PRIORS);
    },
  };
}
