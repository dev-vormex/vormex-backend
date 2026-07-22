import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, prismaRead } from '../config/prisma';
import {
  evaluateCascadeGate,
  inversePropensityWeight,
  stableUnitInterval,
  type RecommendationSurface,
} from './recommendation-engine.service';

const FEATURE_NAMES = ['semantic', 'relationship', 'socialProof', 'quality', 'freshness', 'exploration', 'cohortFit'] as const;
type HeadName = 'useful' | 'quality_dwell' | 'skip' | 'negative_feedback';

const HEAD_THRESHOLDS: Record<HeadName, number> = {
  useful: 2_000,
  quality_dwell: 10_000,
  skip: 10_000,
  negative_feedback: 500,
};

export async function seedSocialCascadeAudiences(): Promise<{ reactions: number; deliveries: number }> {
  const reactions = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT DISTINCT ON (e."surface", e."entityType", e."entityId", e."userId")
      e."surface", e."entityType", e."entityId", e."userId" AS actor_id,
      COALESCE(p."authorId", r."authorId") AS author_id,
      COALESCE(source_delivery."wave" + 1, 1) AS target_wave
    FROM "recommendation_events" e
    JOIN "users" actor ON actor."id" = e."userId"
    LEFT JOIN "posts" p ON e."entityType" = 'POST' AND p."id" = e."entityId"
      AND p."isActive" = true AND lower(p."visibility") = 'public'
    LEFT JOIN "reels" r ON e."entityType" = 'REEL' AND r."id" = e."entityId"
      AND r."status" = 'ready' AND lower(r."visibility") = 'public'
    LEFT JOIN "recommendation_cascade_deliveries" source_delivery
      ON source_delivery."surface" = e."surface" AND source_delivery."entityType" = e."entityType"
      AND source_delivery."entityId" = e."entityId" AND source_delivery."viewerId" = e."userId"
    WHERE e."eventType" = 'REACTION' AND e."isBoosted" = false
      AND e."entityType" IN ('POST', 'REEL')
      AND e."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '30 minutes'
      AND actor."identityTrustLevel" <> 'BASIC' AND actor."isBanned" = false
      AND (actor."safetyRestrictedUntil" IS NULL OR actor."safetyRestrictedUntil" < CURRENT_TIMESTAMP)
      AND (actor."safetySuspendedUntil" IS NULL OR actor."safetySuspendedUntil" < CURRENT_TIMESTAMP)
      AND COALESCE(p."authorId", r."authorId") IS NOT NULL
      AND e."userId" <> COALESCE(p."authorId", r."authorId")
    ORDER BY e."surface", e."entityType", e."entityId", e."userId", e."occurredAt" DESC
    LIMIT 500
  `);
  let deliveries = 0;
  for (const reaction of reactions) {
    const wave = Math.min(2, Math.max(1, Number(reaction.target_wave || 1)));
    if (Number(reaction.target_wave || 1) > 2) continue;
    const audience = await prismaRead.$queryRaw<any[]>(Prisma.sql`
      WITH network AS (
        SELECT f."followerId" AS viewer_id FROM "follows" f WHERE f."followingId" = ${reaction.actor_id}
        UNION
        SELECT CASE WHEN c."requesterId" = ${reaction.actor_id} THEN c."addresseeId" ELSE c."requesterId" END
        FROM "connections" c
        WHERE c."status" = 'accepted' AND (c."requesterId" = ${reaction.actor_id} OR c."addresseeId" = ${reaction.actor_id})
      )
      SELECT DISTINCT u."id"
      FROM network n JOIN "users" u ON u."id" = n.viewer_id
      WHERE u."id" NOT IN (${reaction.actor_id}, ${reaction.author_id}) AND u."isBanned" = false
        AND (u."safetyRestrictedUntil" IS NULL OR u."safetyRestrictedUntil" < CURRENT_TIMESTAMP)
        AND (u."safetySuspendedUntil" IS NULL OR u."safetySuspendedUntil" < CURRENT_TIMESTAMP)
        AND NOT EXISTS (
          SELECT 1 FROM "user_blocks" b
          WHERE (b."blockerId" = u."id" AND b."blockedId" = ${reaction.author_id})
             OR (b."blockerId" = ${reaction.author_id} AND b."blockedId" = u."id")
        )
        AND NOT EXISTS (
          SELECT 1 FROM "recommendation_feedback" f
          WHERE f."userId" = u."id" AND f."isActive" = true
            AND (f."entityId" = ${reaction.entityId} OR f."authorId" = ${reaction.author_id})
        )
        AND NOT EXISTS (
          SELECT 1 FROM "recommendation_cascade_deliveries" d
          WHERE d."surface" = ${reaction.surface} AND d."entityType" = ${reaction.entityType}
            AND d."entityId" = ${reaction.entityId} AND d."viewerId" = u."id"
        )
      LIMIT 500
    `);
    const previousWaveSize = wave === 1
      ? Math.max(1, await directNetworkSize(String(reaction.author_id)))
      : Number((await prismaRead.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS count FROM "recommendation_cascade_deliveries"
          WHERE "surface" = ${reaction.surface} AND "entityType" = ${reaction.entityType}
            AND "entityId" = ${reaction.entityId} AND "wave" = ${wave - 1}
        `))[0]?.count || 0);
    const currentWaveSize = Number((await prismaRead.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM "recommendation_cascade_deliveries"
      WHERE "surface" = ${reaction.surface} AND "entityType" = ${reaction.entityType}
        AND "entityId" = ${reaction.entityId} AND "wave" = ${wave}
    `))[0]?.count || 0);
    const allowance = Math.min(20, Math.max(0, previousWaveSize * 5 - currentWaveSize));
    const selected = audience
      .sort((left, right) => stableUnitInterval(`${reaction.entityId}:${reaction.actor_id}:${left.id}`)
        - stableUnitInterval(`${reaction.entityId}:${reaction.actor_id}:${right.id}`))
      .slice(0, allowance);
    for (const viewer of selected) {
      const inserted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "recommendation_cascade_deliveries"
          ("id", "surface", "entityType", "entityId", "viewerId", "sourceActorId", "wave", "batch")
        VALUES (${randomUUID()}, ${reaction.surface}, ${reaction.entityType}, ${reaction.entityId}, ${viewer.id},
          ${reaction.actor_id}, ${wave}, 0)
        ON CONFLICT ("surface", "entityType", "entityId", "viewerId") DO NOTHING
        RETURNING "id"
      `);
      deliveries += inserted.length;
    }
  }
  return { reactions: reactions.length, deliveries };
}

async function directNetworkSize(authorId: string): Promise<number> {
  const rows = await prismaRead.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(DISTINCT viewer_id)::bigint AS count FROM (
      SELECT "followerId" AS viewer_id FROM "follows" WHERE "followingId" = ${authorId}
      UNION
      SELECT CASE WHEN "requesterId" = ${authorId} THEN "addresseeId" ELSE "requesterId" END
      FROM "connections" WHERE "status" = 'accepted' AND ("requesterId" = ${authorId} OR "addresseeId" = ${authorId})
    ) network
  `);
  return Number(rows[0]?.count || 0);
}

async function releaseCohortAudience(input: {
  surface: string;
  entityType: string;
  entityId: string;
  authorId?: string | null;
  batch: number;
  limit: number;
}): Promise<number> {
  const candidates = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT u."id"
    FROM "users" u
    LEFT JOIN "recommendation_user_profiles" profile ON profile."userId" = u."id"
    LEFT JOIN "discovery_documents" document ON document."entityType" = lower(${input.entityType})
      AND document."entityId" = ${input.entityId} AND document."eligibilityStatus" = 'eligible'
    WHERE u."isBanned" = false AND u."id" <> ${input.authorId || ''}
      AND COALESCE(profile."personalizedRecommendationsEnabled", true) = true
      AND (u."safetyRestrictedUntil" IS NULL OR u."safetyRestrictedUntil" < CURRENT_TIMESTAMP)
      AND (u."safetySuspendedUntil" IS NULL OR u."safetySuspendedUntil" < CURRENT_TIMESTAMP)
      AND NOT EXISTS (
        SELECT 1 FROM "recommendation_cascade_deliveries" d
        WHERE d."surface" = ${input.surface} AND d."entityType" = ${input.entityType}
          AND d."entityId" = ${input.entityId} AND d."viewerId" = u."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "recommendation_feedback" f WHERE f."userId" = u."id" AND f."isActive" = true
          AND (f."entityId" = ${input.entityId} OR f."authorId" = ${input.authorId || ''})
      )
      AND NOT EXISTS (
        SELECT 1 FROM "user_blocks" b WHERE ${input.authorId || ''} <> '' AND (
          (b."blockerId" = u."id" AND b."blockedId" = ${input.authorId || ''}) OR
          (b."blockerId" = ${input.authorId || ''} AND b."blockedId" = u."id")
        )
      )
    ORDER BY CASE WHEN profile."positiveVector" IS NOT NULL AND document."embedding" IS NOT NULL
      THEN profile."positiveVector" <=> document."embedding" ELSE 2 END ASC,
      md5(u."id" || ${input.entityId}) ASC
    LIMIT ${Math.min(500, Math.max(0, input.limit))}
  `);
  let insertedCount = 0;
  for (const viewer of candidates) {
    const inserted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "recommendation_cascade_deliveries"
        ("id", "surface", "entityType", "entityId", "viewerId", "wave", "batch")
      VALUES (${randomUUID()}, ${input.surface}, ${input.entityType}, ${input.entityId}, ${viewer.id}, 3, ${input.batch})
      ON CONFLICT ("surface", "entityType", "entityId", "viewerId") DO NOTHING RETURNING "id"
    `);
    insertedCount += inserted.length;
  }
  return insertedCount;
}

export async function aggregateRecommendationEvents(now = new Date()): Promise<void> {
  const firstDay = new Date(now);
  firstDay.setUTCDate(firstDay.getUTCDate() - 1);
  firstDay.setUTCHours(0, 0, 0, 0);

  await prisma.$executeRaw(Prisma.sql`
    WITH entity_stats AS (
      SELECT
        date_trunc('day', e."occurredAt")::date AS day,
        e."surface",
        e."entityType",
        e."entityId",
        COUNT(*) FILTER (WHERE e."qualifiedExposure" AND NOT e."isBoosted")::int AS organic_impressions,
        COUNT(DISTINCT (e."userId", e."recommendationSessionId")) FILTER (WHERE e."cascadeEngagement" AND NOT e."isBoosted")::int AS organic_cascade,
        COUNT(DISTINCT (e."userId", e."recommendationSessionId")) FILTER (WHERE e."qualifiedPositive" AND NOT e."isBoosted")::int AS organic_positive,
        COUNT(DISTINCT (e."userId", e."recommendationSessionId")) FILTER (WHERE e."meaningfulOutcome" AND NOT e."isBoosted")::int AS organic_meaningful,
        COUNT(*) FILTER (WHERE e."eventType" = 'NEGATIVE_FEEDBACK' AND NOT e."isBoosted")::int AS organic_negative,
        COUNT(*) FILTER (WHERE e."qualifiedExposure" AND e."isBoosted")::int AS boosted_impressions,
        COUNT(*) FILTER (WHERE e."eventType" IN ('DETAIL_OPEN', 'PROFILE_OPEN') AND e."isBoosted")::int AS boosted_clicks,
        COUNT(*) FILTER (WHERE e."meaningfulOutcome" AND e."isBoosted")::int AS boosted_meaningful,
        COUNT(DISTINCT e."userId") FILTER (
          WHERE e."cascadeEngagement" AND NOT e."isBoosted" AND u."isBanned" = false
            AND (u."safetyRestrictedUntil" IS NULL OR u."safetyRestrictedUntil" < CURRENT_TIMESTAMP)
            AND (u."safetySuspendedUntil" IS NULL OR u."safetySuspendedUntil" < CURRENT_TIMESTAMP)
            AND e."userId" <> COALESCE(p."authorId", r."authorId", s."authorId", ce."organizerId",
              CASE WHEN e."entityType" = 'PERSON' THEN e."entityId" ELSE NULL END, '')
        )::int AS independent_reactors
      FROM "recommendation_events" e
      JOIN "users" u ON u."id" = e."userId"
      LEFT JOIN "posts" p ON e."entityType" = 'POST' AND p."id" = e."entityId"
      LEFT JOIN "reels" r ON e."entityType" = 'REEL' AND r."id" = e."entityId"
      LEFT JOIN "stories" s ON e."entityType" = 'STORY' AND s."id" = e."entityId"
      LEFT JOIN "campus_events" ce ON e."entityType" = 'EVENT' AND ce."id" = e."entityId"
      WHERE e."occurredAt" >= ${firstDay}
      GROUP BY 1, 2, 3, 4
    )
    INSERT INTO "recommendation_item_daily_stats"
      ("id", "day", "surface", "entityType", "entityId", "organicImpressions",
       "organicCascadeEngagements", "organicQualifiedPositives", "organicMeaningfulOutcomes",
       "organicNegativeFeedback", "boostedImpressions", "boostedClicks", "boostedMeaningfulOutcomes",
       "independentReactors", "updatedAt")
    SELECT
      md5(random()::text || clock_timestamp()::text || "entityId"), day, "surface", "entityType", "entityId",
      organic_impressions, organic_cascade, organic_positive, organic_meaningful, organic_negative,
      boosted_impressions, boosted_clicks, boosted_meaningful, independent_reactors, CURRENT_TIMESTAMP
    FROM entity_stats
    ON CONFLICT ("day", "surface", "entityType", "entityId") DO UPDATE SET
      "organicImpressions" = EXCLUDED."organicImpressions",
      "organicCascadeEngagements" = EXCLUDED."organicCascadeEngagements",
      "organicQualifiedPositives" = EXCLUDED."organicQualifiedPositives",
      "organicMeaningfulOutcomes" = EXCLUDED."organicMeaningfulOutcomes",
      "organicNegativeFeedback" = EXCLUDED."organicNegativeFeedback",
      "boostedImpressions" = EXCLUDED."boostedImpressions",
      "boostedClicks" = EXCLUDED."boostedClicks",
      "boostedMeaningfulOutcomes" = EXCLUDED."boostedMeaningfulOutcomes",
      "independentReactors" = EXCLUDED."independentReactors",
      "updatedAt" = CURRENT_TIMESTAMP
  `);
}

export async function updateCascadeStates(): Promise<{ evaluated: number; stopped: number; expanded: number }> {
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    WITH stats AS (
      SELECT "surface", "entityType", "entityId",
        SUM("organicImpressions")::int AS impressions,
        SUM("organicCascadeEngagements")::int AS engagements,
        SUM("organicMeaningfulOutcomes")::int AS meaningful,
        SUM("organicNegativeFeedback")::int AS negatives,
        MAX("independentReactors")::int AS reactors
      FROM "recommendation_item_daily_stats"
      WHERE "day" >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY "surface", "entityType", "entityId"
      HAVING SUM("organicImpressions") > 0
    )
    SELECT stats."surface", stats."entityType", stats."entityId", stats.impressions,
      stats.engagements, stats.meaningful, stats.negatives,
      (
        SELECT COUNT(DISTINCT e."userId")::int
        FROM "recommendation_events" e JOIN "users" reactor ON reactor."id" = e."userId"
        WHERE e."surface" = stats."surface" AND e."entityType" = stats."entityType"
          AND e."entityId" = stats."entityId" AND e."cascadeEngagement" = true AND e."isBoosted" = false
          AND e."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '7 days'
          AND reactor."identityTrustLevel" <> 'BASIC' AND reactor."isBanned" = false
          AND (reactor."safetyRestrictedUntil" IS NULL OR reactor."safetyRestrictedUntil" < CURRENT_TIMESTAMP)
          AND (reactor."safetySuspendedUntil" IS NULL OR reactor."safetySuspendedUntil" < CURRENT_TIMESTAMP)
          AND e."userId" <> COALESCE(
            (SELECT p."authorId" FROM "posts" p WHERE stats."entityType" = 'POST' AND p."id" = stats."entityId"),
            (SELECT r."authorId" FROM "reels" r WHERE stats."entityType" = 'REEL' AND r."id" = stats."entityId"),
            (SELECT s."authorId" FROM "stories" s WHERE stats."entityType" = 'STORY' AND s."id" = stats."entityId"),
            (SELECT ce."organizerId" FROM "campus_events" ce WHERE stats."entityType" = 'EVENT' AND ce."id" = stats."entityId"),
            CASE WHEN stats."entityType" = 'PERSON' THEN stats."entityId" ELSE '' END
          )
      ) AS reactors,
      COALESCE(
        (SELECT p."authorId" FROM "posts" p WHERE stats."entityType" = 'POST' AND p."id" = stats."entityId"),
        (SELECT r."authorId" FROM "reels" r WHERE stats."entityType" = 'REEL' AND r."id" = stats."entityId"),
        (SELECT s."authorId" FROM "stories" s WHERE stats."entityType" = 'STORY' AND s."id" = stats."entityId"),
        (SELECT ce."organizerId" FROM "campus_events" ce WHERE stats."entityType" = 'EVENT' AND ce."id" = stats."entityId")
      ) AS author_id,
      CASE
        WHEN stats."entityType" = 'POST' THEN NOT EXISTS (
          SELECT 1 FROM "posts" p WHERE p."id" = stats."entityId" AND p."isActive" = true AND lower(p."visibility") = 'public'
        ) OR EXISTS (
          SELECT 1 FROM "moderation_reports" mr
          WHERE mr."reportedPostId" = stats."entityId" AND upper(mr."status") IN ('PENDING', 'UNDER_REVIEW')
        )
        WHEN stats."entityType" = 'REEL' THEN NOT EXISTS (
          SELECT 1 FROM "reels" r WHERE r."id" = stats."entityId" AND r."status" = 'ready' AND lower(r."visibility") = 'public'
        ) OR EXISTS (
          SELECT 1 FROM "reel_reports" rr WHERE rr."reelId" = stats."entityId" AND lower(rr."status") IN ('pending', 'under_review')
        )
        WHEN stats."entityType" = 'STORY' THEN NOT EXISTS (
          SELECT 1 FROM "stories" s WHERE s."id" = stats."entityId" AND s."expiresAt" > CURRENT_TIMESTAMP
        )
        WHEN stats."entityType" = 'PERSON' THEN EXISTS (
          SELECT 1 FROM "users" u WHERE u."id" = stats."entityId" AND (
            u."isBanned" = true OR u."safetyRestrictedUntil" > CURRENT_TIMESTAMP OR u."safetySuspendedUntil" > CURRENT_TIMESTAMP
          )
        )
        ELSE false
      END AS safety_blocked,
      CASE
        WHEN stats."entityType" = 'POST' THEN NOT EXISTS (
          SELECT 1 FROM "posts" p WHERE p."id" = stats."entityId" AND p."createdAt" >= CURRENT_TIMESTAMP - INTERVAL '7 days'
        )
        WHEN stats."entityType" = 'REEL' THEN NOT EXISTS (
          SELECT 1 FROM "reels" r WHERE r."id" = stats."entityId"
            AND COALESCE(r."publishedAt", r."createdAt") >= CURRENT_TIMESTAMP - INTERVAL '10 days'
        )
        WHEN stats."entityType" = 'STORY' THEN NOT EXISTS (
          SELECT 1 FROM "stories" s WHERE s."id" = stats."entityId" AND s."expiresAt" > CURRENT_TIMESTAMP
        )
        WHEN stats."entityType" = 'EVENT' THEN NOT EXISTS (
          SELECT 1 FROM "campus_events" ce WHERE ce."id" = stats."entityId" AND ce."endsAt" > CURRENT_TIMESTAMP
        )
        ELSE false
      END AS freshness_expired
    FROM stats
    LIMIT 10000
  `);
  const baselines = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT "surface",
      SUM("organicCascadeEngagements")::double precision / NULLIF(SUM("organicImpressions"), 0) AS baseline,
      SUM("organicMeaningfulOutcomes")::double precision / NULLIF(SUM("organicImpressions"), 0) AS meaningful_baseline
    FROM "recommendation_item_daily_stats"
    WHERE "day" >= CURRENT_DATE - INTERVAL '30 days' AND "organicImpressions" > 0
    GROUP BY "surface"
  `);
  const baselineBySurface = new Map(baselines.map((row: any) => [String(row.surface), row]));
  const existingStates = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT "surface", "entityType", "entityId", "wave", "releasedViewerCount",
      "lastImpressionSequence", "status", "stopReason"
    FROM "recommendation_cascade_states"
  `);
  const stateByEntity = new Map(existingStates.map((row: any) => [
    `${row.surface}:${row.entityType}:${row.entityId}`,
    row,
  ]));
  const trailingRows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    WITH exposures AS (
      SELECT e."surface", e."entityType", e."entityId", e."userId", e."recommendationSessionId", e."occurredAt",
        ROW_NUMBER() OVER (
          PARTITION BY e."surface", e."entityType", e."entityId"
          ORDER BY e."occurredAt" DESC, e."id" DESC
        ) - 1 AS recency,
        EXISTS (
          SELECT 1 FROM "recommendation_events" positive
          WHERE positive."userId" = e."userId"
            AND positive."entityType" = e."entityType" AND positive."entityId" = e."entityId"
            AND positive."recommendationSessionId" = e."recommendationSessionId"
            AND positive."cascadeEngagement" = true AND positive."isBoosted" = false
            AND positive."occurredAt" BETWEEN e."occurredAt" AND e."occurredAt" + INTERVAL '24 hours'
        ) AS success
      FROM "recommendation_events" e
      WHERE e."qualifiedExposure" = true AND e."isBoosted" = false
        AND e."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '7 days'
    )
    SELECT "surface", "entityType", "entityId",
      SUM(POWER(0.5, recency / 100.0)) FILTER (WHERE success)::double precision AS weighted_successes,
      SUM(POWER(0.5, recency / 100.0)) FILTER (WHERE NOT success)::double precision AS weighted_failures
    FROM exposures
    GROUP BY "surface", "entityType", "entityId"
  `);
  const trailingByEntity = new Map(trailingRows.map((row: any) => [
    `${row.surface}:${row.entityType}:${row.entityId}`,
    row,
  ]));
  let stopped = 0;
  let expanded = 0;
  for (const row of rows) {
    const stateKey = `${row.surface}:${row.entityType}:${row.entityId}`;
    const existing = stateByEntity.get(stateKey);
    if (existing?.status === 'stopped') continue;
    const baseline = baselineBySurface.get(String(row.surface));
    const trailing = trailingByEntity.get(stateKey);
    let decision = evaluateCascadeGate({
      qualifiedImpressions: Number(row.impressions || 0),
      cascadeEngagements: Number(row.engagements || 0),
      meaningfulOutcomes: Number(row.meaningful || 0),
      independentReactors: Number(row.reactors || 0),
      baseline: Math.min(0.95, Math.max(0.01, Number(baseline?.baseline || 0.08))),
      meaningfulBaseline: Math.min(0.5, Math.max(0.001, Number(baseline?.meaningful_baseline || 0.02))),
      negativeFeedbackCount: Number(row.negatives || 0),
      safetyBlocked: Boolean(row.safety_blocked),
      freshnessExpired: Boolean(row.freshness_expired),
      trailingWeightedSuccesses: Number(trailing?.weighted_successes || 0),
      trailingWeightedFailures: Number(trailing?.weighted_failures || 0),
    });
    const impressions = Number(row.impressions || 0);
    const lastReleaseSequence = Number(existing?.lastImpressionSequence || 0);
    const alreadyReleasedWaveOne = Number(existing?.wave || 0) >= 1;
    const alreadyReleasedCohort = Number(existing?.wave || 0) >= 2;
    const cohortHasNewBatchEvidence = !alreadyReleasedCohort
      || (lastReleaseSequence < 500 ? impressions >= 500 : impressions - lastReleaseSequence >= 500);
    if (
      (decision.action === 'EXPAND_TO_75' && alreadyReleasedWaveOne) ||
      (decision.action === 'EXPAND_COHORT_BATCH' && !cohortHasNewBatchEvidence)
    ) {
      decision = {
        ...decision,
        action: 'HOLD',
        maximumAdditionalViewers: 0,
        reason: 'AWAITING_NEW_BATCH_EVIDENCE',
      };
    }
    if (decision.action === 'EXPAND_COHORT_BATCH') {
      const delivered = await releaseCohortAudience({
        surface: String(row.surface),
        entityType: String(row.entityType),
        entityId: String(row.entityId),
        authorId: row.author_id ? String(row.author_id) : null,
        batch: Math.floor(Number(existing?.releasedViewerCount || 0) / 500) + 1,
        limit: decision.maximumAdditionalViewers,
      });
      decision = delivered > 0
        ? { ...decision, maximumAdditionalViewers: delivered }
        : { ...decision, action: 'HOLD', maximumAdditionalViewers: 0, reason: 'NO_ELIGIBLE_COHORT_INVENTORY' };
    }
    const nextWave = decision.action === 'EXPAND_TO_75' ? 1 : decision.action === 'EXPAND_COHORT_BATCH' ? 2 : 0;
    const status = decision.action === 'STOP' ? 'stopped' : 'active';
    const releaseSequence = nextWave > 0 ? impressions : lastReleaseSequence;
    if (status === 'stopped') stopped += 1;
    if (nextWave > 0) expanded += 1;
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "recommendation_cascade_states"
        ("id", "surface", "entityType", "entityId", "wave", "qualifiedImpressions", "cascadeEngagements",
         "meaningfulOutcomes", "independentReactors", "releasedViewerCount", "status", "stopReason",
         "trailingWeightedSuccesses", "trailingWeightedFailures", "lastImpressionSequence",
         "lastEvaluatedAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${row.surface}, ${row.entityType}, ${row.entityId}, ${nextWave}, ${Number(row.impressions || 0)},
         ${Number(row.engagements || 0)}, ${Number(row.meaningful || 0)}, ${Number(row.reactors || 0)},
         ${decision.maximumAdditionalViewers}, ${status}, ${status === 'stopped' ? decision.reason : null},
         ${Number(trailing?.weighted_successes || 0)}, ${Number(trailing?.weighted_failures || 0)},
         ${releaseSequence}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("surface", "entityType", "entityId") DO UPDATE SET
        "wave" = GREATEST("recommendation_cascade_states"."wave", EXCLUDED."wave"),
        "qualifiedImpressions" = EXCLUDED."qualifiedImpressions",
        "cascadeEngagements" = EXCLUDED."cascadeEngagements",
        "meaningfulOutcomes" = EXCLUDED."meaningfulOutcomes",
        "independentReactors" = EXCLUDED."independentReactors",
        "releasedViewerCount" = "recommendation_cascade_states"."releasedViewerCount" + EXCLUDED."releasedViewerCount",
        "status" = EXCLUDED."status", "stopReason" = EXCLUDED."stopReason",
        "trailingWeightedSuccesses" = EXCLUDED."trailingWeightedSuccesses",
        "trailingWeightedFailures" = EXCLUDED."trailingWeightedFailures",
        "lastImpressionSequence" = EXCLUDED."lastImpressionSequence",
        "lastEvaluatedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    `);
  }
  return { evaluated: rows.length, stopped, expanded };
}

interface TrainingExample {
  features: number[];
  label: number;
  propensity: number;
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function trainLogistic(examples: TrainingExample[], l2 = 0.01, epochs = 30): { intercept: number; coefficients: number[] } {
  const coefficients = Array(FEATURE_NAMES.length).fill(0) as number[];
  let intercept = 0;
  const rawWeights = examples.map((example) => 1 / Math.max(0.0001, example.propensity || 1));
  const normalizer = rawWeights.reduce((sum, value) => sum + value, 0) / Math.max(1, rawWeights.length);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = 0.12 / Math.sqrt(epoch + 1);
    const gradient = Array(coefficients.length).fill(0) as number[];
    let interceptGradient = 0;
    for (const example of examples) {
      const prediction = sigmoid(intercept + example.features.reduce((sum, value, index) => sum + value * coefficients[index], 0));
      const weight = inversePropensityWeight(example.propensity || 1, normalizer);
      const error = (prediction - example.label) * weight;
      interceptGradient += error;
      example.features.forEach((value, index) => { gradient[index] += error * value; });
    }
    intercept -= rate * interceptGradient / examples.length;
    coefficients.forEach((value, index) => {
      coefficients[index] -= rate * (gradient[index] / examples.length + l2 * value);
    });
  }
  return { intercept, coefficients };
}

function labelForHead(row: any, head: HeadName): number {
  if (head === 'useful') return row.useful ? 1 : 0;
  if (head === 'quality_dwell') return row.qualityDwell ? 1 : 0;
  if (head === 'skip') return row.skipped ? 1 : 0;
  return row.negative ? 1 : 0;
}

export async function trainRecommendationModels(): Promise<{ trained: string[]; skipped: string[] }> {
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT e."surface", e."userId", e."recommendationSessionId", e."entityType", e."entityId",
      e."examinationPropensity", e."qualifiedPositive" AS "qualityDwell",
      COALESCE((e."metadata"->'rankingFeatures'), '{}'::jsonb) AS features,
      EXISTS (SELECT 1 FROM "recommendation_events" o
        WHERE o."userId" = e."userId" AND o."recommendationSessionId" = e."recommendationSessionId"
          AND o."entityType" = e."entityType" AND o."entityId" = e."entityId" AND o."meaningfulOutcome") AS useful,
      EXISTS (SELECT 1 FROM "recommendation_events" o
        WHERE o."userId" = e."userId" AND o."recommendationSessionId" = e."recommendationSessionId"
          AND o."entityType" = e."entityType" AND o."entityId" = e."entityId" AND o."eventType" = 'SKIP') AS skipped,
      EXISTS (SELECT 1 FROM "recommendation_feedback" f
        WHERE f."userId" = e."userId" AND f."entityType" = e."entityType" AND f."entityId" = e."entityId"
          AND f."isActive" = true) AS negative
    FROM "recommendation_events" e
    WHERE e."qualifiedExposure" = true AND e."isBoosted" = false
      AND e."experimentVariant" = 'training_exploration'
      AND e."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '90 days'
    ORDER BY e."occurredAt" DESC
    LIMIT 200000
  `);
  const bySurface = new Map<string, any[]>();
  rows.forEach((row) => bySurface.set(String(row.surface), [...(bySurface.get(String(row.surface)) || []), row]));
  const trained: string[] = [];
  const skipped: string[] = [];

  for (const [surface, surfaceRows] of bySurface.entries()) {
    for (const head of Object.keys(HEAD_THRESHOLDS) as HeadName[]) {
      const positives = surfaceRows.reduce((sum, row) => sum + labelForHead(row, head), 0);
      const key = `${surface}:${head}`;
      if (surfaceRows.length < 50_000 || positives < HEAD_THRESHOLDS[head]) {
        skipped.push(key);
        continue;
      }
      const examples: TrainingExample[] = surfaceRows.map((row) => {
        const features = row.features && typeof row.features === 'object' ? row.features : {};
        return {
          features: FEATURE_NAMES.map((name) => Math.min(1, Math.max(0, Number(features[name] ?? 0.5)))),
          label: labelForHead(row, head),
          propensity: Math.min(1, Math.max(0.0001, Number(row.examinationPropensity || 1))),
        };
      });
      const model = trainLogistic(examples);
      const version = `nightly-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "recommendation_models"
          ("id", "surface", "head", "version", "status", "featureSchema", "coefficients", "priors", "thresholds",
           "trainingImpressions", "positiveLabels", "trainedAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${surface as RecommendationSurface}, ${head}, ${version}, 'shadow',
           ${JSON.stringify({ names: FEATURE_NAMES, positionCorrection: 'self_normalized_ipw', weightCap: 10 })}::jsonb,
           ${JSON.stringify({ intercept: model.intercept, values: model.coefficients })}::jsonb,
           ${JSON.stringify({ positiveRate: positives / surfaceRows.length })}::jsonb,
           ${JSON.stringify({ minimumImpressions: 50000, minimumPositiveLabels: HEAD_THRESHOLDS[head] })}::jsonb,
           ${surfaceRows.length}, ${positives}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);
      trained.push(key);
    }
  }
  return { trained, skipped };
}
