import { Prisma } from '@prisma/client';
import { prismaRead } from '../config/prisma';
import {
  applyConstrainedPositionExploration,
  assignRecommendationVariant,
  freshnessScore,
  rankRecommendationCandidates,
  stableUnitInterval,
  type RecommendationCandidate,
  type RecommendationEntityType,
  type RecommendationSurface,
  type RecommendationSource,
} from './recommendation-engine.service';
import { createRecommendationSession, getRecommendationPreferences } from './recommendation-platform.service';
import { loadRecommendationModelBundle } from './recommendation-model-serving.service';
import { loadCachedSemanticScores } from './recommendation-embedding.service';

function searchableText(item: any): string {
  return [
    item?.title, item?.caption, item?.content, item?.description, item?.headline, item?.name,
    item?.college, item?.campus, item?.location,
    ...(Array.isArray(item?.skills) ? item.skills : []),
    ...(Array.isArray(item?.topics) ? item.topics : []),
    ...(Array.isArray(item?.tags) ? item.tags : []),
    ...(Array.isArray(item?.interests) ? item.interests : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

export async function decorateSurfaceRecommendations<T extends Record<string, any>>(input: {
  userId: string;
  surface: RecommendationSurface;
  entityType: RecommendationEntityType;
  items: T[];
  idOf?: (item: T) => string;
  authorIdOf?: (item: T) => string | null | undefined;
  createdAtOf?: (item: T) => Date | string | null | undefined;
  pageSize?: number;
  sessionTtlMs?: number;
}): Promise<{
  items: T[];
  recommendationSessionId?: string;
  requestId?: string;
  rankerVersion?: string;
  experimentVariant?: string;
  recommendationNextCursor?: string | null;
}> {
  const idOf = input.idOf || ((item: T) => String(item.id));
  const authorIdOf = input.authorIdOf || ((item: T) => item.authorId || item.author?.id || item.user?.id);
  const createdAtOf = input.createdAtOf || ((item: T) => item.createdAt || item.publishedAt || item.startsAt);
  const variant = assignRecommendationVariant(input.userId);
  const eventsEnabled = process.env.RECOMMENDATION_EVENTS_ENABLED === 'true';
  let treatment = variant === 'treatment' || variant === 'training_exploration';
  if (treatment) {
    const preferences = await getRecommendationPreferences(input.userId).catch(() => ({ personalizedRecommendationsEnabled: true }));
    treatment = preferences.personalizedRecommendationsEnabled;
  }
  if (!eventsEnabled && !treatment) return { items: input.items };

  const itemIds = input.items.map((item) => idOf(item));
  const semanticEntityType = (input.entityType === 'PERSON' ? 'profile' : input.entityType.toLowerCase()) as
    'post' | 'reel' | 'job' | 'event' | 'profile';
  const [connections, follows, profile, modelBundle, semanticScores, cascadeDeliveries] = await Promise.all([
    prismaRead.connections.findMany({
      where: { status: 'accepted', OR: [{ requesterId: input.userId }, { addresseeId: input.userId }] },
      select: { requesterId: true, addresseeId: true }, take: 500,
    }),
    prismaRead.follows.findMany({ where: { followerId: input.userId }, select: { followingId: true }, take: 500 }),
    prismaRead.user.findUnique({
      where: { id: input.userId },
      select: { interests: true, college: true, branch: true, skills: { select: { skill: { select: { name: true } } } } },
    }),
    loadRecommendationModelBundle(input.surface),
    ['post', 'reel', 'job', 'event', 'profile'].includes(semanticEntityType)
      ? loadCachedSemanticScores(input.userId, semanticEntityType, itemIds)
      : Promise.resolve(new Map<string, number>()),
    itemIds.length ? prismaRead.$queryRaw<any[]>(Prisma.sql`
      SELECT "entityId", "wave" FROM "recommendation_cascade_deliveries"
      WHERE "viewerId" = ${input.userId} AND "surface" = ${input.surface} AND "entityType" = ${input.entityType}
        AND "entityId" IN (${Prisma.join(itemIds)})
    `).catch(() => []) : Promise.resolve([]),
  ]);
  const networkIds = new Set([
    ...connections.flatMap((connection) => [connection.requesterId, connection.addresseeId]),
    ...follows.map((follow) => follow.followingId),
  ].filter((id) => id !== input.userId));
  const interests = [
    ...(profile?.interests || []),
    ...(profile?.skills || []).map((entry) => entry.skill.name),
  ].map((value) => value.toLowerCase());
  const cohort = [profile?.college, profile?.branch].filter(Boolean).map((value) => String(value).toLowerCase());
  const cascadeWaveByItem = new Map(cascadeDeliveries.map((row: any) => [String(row.entityId), Number(row.wave || 0)]));

  const candidates: RecommendationCandidate<T>[] = input.items.map((item) => {
    const id = idOf(item);
    const authorId = authorIdOf(item);
    const text = searchableText(item);
    const semanticMatches = interests.filter((token) => text.includes(token)).length;
    const cachedSemantic = semanticScores.get(id);
    const cascadeWave = cascadeWaveByItem.get(id) || 0;
    const cohortMatches = cohort.filter((token) => text.includes(token)).length;
    const isNetwork = Boolean(authorId && networkIds.has(String(authorId)));
    const sources: RecommendationSource[] = [];
    if (isNetwork) sources.push('NETWORK');
    if (cascadeWave > 0 && cascadeWave <= 2) sources.push('NETWORK_ENGAGED');
    if ((cachedSemantic !== undefined && cachedSemantic > 0) || semanticMatches > 0) sources.push('SEMANTIC');
    if (cohortMatches > 0 || Number(item.viewsCount || item.attendeesCount || 0) > 0) sources.push('COHORT_TRENDING');
    if (cascadeWave >= 3 && !sources.includes('COHORT_TRENDING')) sources.push('COHORT_TRENDING');
    if (stableUnitInterval(`${input.surface}:${input.userId}:${id}`) < 0.25 || sources.length === 0) sources.push('EXPLORATION');
    const engagement = Number(item.likesCount || 0) + 3 * Number(item.commentsCount || 0) + 5 * Number(item.sharesCount || 0);
    const features = {
      semantic: cachedSemantic ?? (interests.length ? Math.min(1, semanticMatches / Math.min(5, interests.length)) : undefined),
      relationship: isNetwork ? 1 : undefined,
      socialProof: engagement ? Math.min(1, Math.log1p(engagement) / Math.log1p(250)) : undefined,
      freshness: createdAtOf(item) ? freshnessScore(createdAtOf(item)!, input.surface === 'REELS' ? 36 : 24) : undefined,
      exploration: 1,
      cohortFit: cohort.length ? Math.min(1, cohortMatches / cohort.length) : undefined,
    };
    return {
      id,
      entityType: input.entityType,
      authorId,
      value: item,
      sources,
      features,
      learnedUtility: modelBundle.learnedUtilityFor(features),
    };
  });
  let ranked = treatment
    ? rankRecommendationCandidates(candidates, {
        limit: 500,
        priors: modelBundle.featurePriors,
        applySeenSuppression: false,
      })
    : candidates.map((candidate, index) => ({
        ...candidate, score: 0, primarySource: candidate.sources[0], reasonCode: 'CURRENT_RANKER',
        reasonText: 'Recommended for you', position: index + 1,
      }));
  if (variant === 'training_exploration') {
    ranked = applyConstrainedPositionExploration(ranked as any, `${input.userId}:${input.surface}:${Date.now()}`) as any;
  }
  const session = await createRecommendationSession({
    userId: input.userId,
    surface: input.surface,
    pageSize: input.pageSize || ranked.length || 1,
    experimentVariant: variant,
    ttlMs: input.sessionTtlMs,
    orderedItems: ranked.map((item) => ({
      entityType: input.entityType,
      entityId: item.id,
      authorId: item.authorId,
      position: item.position,
      reasonCode: item.reasonCode,
      reasonText: item.reasonText,
      source: item.primarySource,
      examinationPropensity: (item as any).examinationPropensity,
      features: item.features,
    })),
  });
  const metadata = new Map(session.items.map((item) => [item.entityId, item]));
  const output = session.items.map((snapshotItem) => {
    const rankedItem = ranked.find((item) => item.id === snapshotItem.entityId);
    return rankedItem ? {
      ...rankedItem.value,
      reasonCode: snapshotItem.reasonCode,
      reasonText: snapshotItem.reasonText,
      source: snapshotItem.source,
      position: snapshotItem.position,
      isBoosted: false,
      socialActors: [],
    } : null;
  }).filter(Boolean) as T[];
  return {
    items: output,
    recommendationSessionId: session.envelope.recommendationSessionId,
    requestId: session.envelope.requestId,
    rankerVersion: session.envelope.rankerVersion,
    experimentVariant: session.envelope.experimentVariant,
    recommendationNextCursor: session.envelope.nextCursor,
  };
}
