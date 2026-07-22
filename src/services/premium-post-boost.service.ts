import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, prismaRead } from '../config/prisma';
import { getPremiumAccessSnapshot } from './premium-access.service';
import { loadCachedSemanticScores } from './recommendation-embedding.service';

const CREDITS_PER_WINDOW = 2;
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000;

function entitlementKey(subscription: any, startsAt: Date): string {
  return `${subscription?.id || 'premium'}:${startsAt.toISOString()}`;
}

async function entitlementWindow(userId: string): Promise<{
  key: string;
  startsAt: Date;
  endsAt: Date;
}> {
  const snapshot = await getPremiumAccessSnapshot(userId);
  if (!snapshot.isPremium) throw new Error('PREMIUM_REQUIRED');
  const subscription = await prismaRead.subscriptions.findUnique({ where: { userId } });
  const startsAt = subscription?.currentPeriodStart || snapshot.premiumStartedAt || new Date();
  const endsAt = subscription?.currentPeriodEnd || snapshot.premiumEndsAt || new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { key: entitlementKey(subscription, startsAt), startsAt, endsAt };
}

export async function getPostBoostCredits(userId: string): Promise<{
  creditsGranted: number;
  creditsConsumed: number;
  creditsRemaining: number;
  windowStartsAt: string;
  windowEndsAt: string;
}> {
  const window = await entitlementWindow(userId);
  const id = randomUUID();
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "premium_boost_credit_windows"
      ("id", "userId", "entitlementKey", "windowStartsAt", "windowEndsAt", "creditsGranted", "creditsConsumed", "updatedAt")
    VALUES (${id}, ${userId}, ${window.key}, ${window.startsAt}, ${window.endsAt}, ${CREDITS_PER_WINDOW}, 0, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "entitlementKey") DO UPDATE SET
      "windowEndsAt" = EXCLUDED."windowEndsAt", "updatedAt" = CURRENT_TIMESTAMP
  `);
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "premium_boost_credit_windows"
    WHERE "userId" = ${userId} AND "entitlementKey" = ${window.key} LIMIT 1
  `);
  const record = rows[0];
  const granted = Number(record?.creditsGranted || CREDITS_PER_WINDOW);
  const consumed = Number(record?.creditsConsumed || 0);
  return {
    creditsGranted: granted,
    creditsConsumed: consumed,
    creditsRemaining: Math.max(0, granted - consumed),
    windowStartsAt: new Date(record?.windowStartsAt || window.startsAt).toISOString(),
    windowEndsAt: new Date(record?.windowEndsAt || window.endsAt).toISOString(),
  };
}

export async function createPostBoostCampaign(userId: string, postId: string): Promise<any> {
  if (process.env.PREMIUM_POST_BOOST_ENABLED !== 'true') throw new Error('POST_BOOST_DISABLED');
  const window = await entitlementWindow(userId);
  const post = await prismaRead.post.findFirst({
    where: { id: postId, authorId: userId, isActive: true, visibility: 'public' },
    select: { id: true, authorId: true, content: true, type: true, metadata: true },
  });
  if (!post) throw new Error('POST_NOT_ELIGIBLE');

  const campaignId = randomUUID();
  const windowId = randomUUID();
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + BOOST_DURATION_MS);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "premium_boost_credit_windows"
        ("id", "userId", "entitlementKey", "windowStartsAt", "windowEndsAt", "creditsGranted", "creditsConsumed", "updatedAt")
      VALUES (${windowId}, ${userId}, ${window.key}, ${window.startsAt}, ${window.endsAt}, ${CREDITS_PER_WINDOW}, 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("userId", "entitlementKey") DO UPDATE SET
        "windowEndsAt" = EXCLUDED."windowEndsAt", "updatedAt" = CURRENT_TIMESTAMP
    `);
    const locked = await tx.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM "premium_boost_credit_windows"
      WHERE "userId" = ${userId} AND "entitlementKey" = ${window.key}
      FOR UPDATE
    `);
    const credit = locked[0];
    if (!credit || Number(credit.creditsConsumed) >= Number(credit.creditsGranted)) throw new Error('NO_BOOST_CREDITS');
    const active = await tx.$queryRaw<any[]>(Prisma.sql`
      SELECT "id" FROM "premium_post_boost_campaigns"
      WHERE "status" = 'active' AND ("userId" = ${userId} OR "postId" = ${postId}) AND "endsAt" > CURRENT_TIMESTAMP
      LIMIT 1
    `);
    if (active.length > 0) throw new Error('ACTIVE_BOOST_EXISTS');
    await tx.$executeRaw(Prisma.sql`
      UPDATE "premium_boost_credit_windows"
      SET "creditsConsumed" = "creditsConsumed" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${credit.id}
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "premium_post_boost_campaigns"
        ("id", "userId", "postId", "creditWindowId", "status", "startsAt", "endsAt", "targeting", "updatedAt")
      VALUES
        (${campaignId}, ${userId}, ${postId}, ${credit.id}, 'active', ${startsAt}, ${endsAt},
         ${JSON.stringify({ mode: 'automatic', entityType: 'POST' })}::jsonb, CURRENT_TIMESTAMP)
    `);
  });
  return getPostBoostCampaign(userId, campaignId);
}

export async function getPostBoostCampaign(userId: string, campaignId: string): Promise<any> {
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT c.*, p."content", p."type" AS "postType"
    FROM "premium_post_boost_campaigns" c
    JOIN "posts" p ON p."id" = c."postId"
    WHERE c."id" = ${campaignId} AND c."userId" = ${userId}
    LIMIT 1
  `);
  if (!rows[0]) throw new Error('CAMPAIGN_NOT_FOUND');
  const row = rows[0];
  return {
    id: row.id,
    postId: row.postId,
    status: row.status,
    startsAt: new Date(row.startsAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
    impressions: Number(row.impressionsCount || 0),
    clicks: Number(row.clicksCount || 0),
    meaningfulActions: Number(row.meaningfulActionsCount || 0),
    negativeFeedback: Number(row.negativeFeedbackCount || 0),
    pauseReason: row.pauseReason || null,
    post: { content: row.content, type: row.postType },
  };
}

export async function listMyPostBoostCampaigns(userId: string): Promise<any[]> {
  const rows = await prismaRead.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "premium_post_boost_campaigns"
    WHERE "userId" = ${userId} ORDER BY "createdAt" DESC LIMIT 50
  `);
  return Promise.all(rows.map((row) => getPostBoostCampaign(userId, row.id)));
}

export async function cancelPostBoostCampaign(userId: string, campaignId: string): Promise<any> {
  const changed = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "premium_post_boost_campaigns"
    SET "status" = 'cancelled', "cancelledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${campaignId} AND "userId" = ${userId} AND "status" = 'active'
    RETURNING "id"
  `);
  if (changed.length === 0) throw new Error('CAMPAIGN_NOT_ACTIVE');
  return getPostBoostCampaign(userId, campaignId);
}

export async function selectPostBoostPlacements(input: {
  viewerId: string;
  organicItemCount: number;
  alreadyReservedInsertions?: number;
  blockedAuthorIds?: string[];
}): Promise<Array<{ type: 'BOOSTED_POST'; position: number; campaignId: string; postId: string; label: 'Boosted' }>> {
  if (process.env.PREMIUM_POST_BOOST_ENABLED !== 'true' || input.organicItemCount < 8) return [];
  if (Number(input.alreadyReservedInsertions || 0) >= 3) return [];
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "premium_post_boost_campaigns" c
    SET "status" = 'paused', "pauseReason" = 'SAFETY', "updatedAt" = CURRENT_TIMESTAMP
    WHERE c."status" = 'active' AND (
      EXISTS (
        SELECT 1 FROM "moderation_reports" mr
        WHERE mr."reportedPostId" = c."postId" AND upper(mr."status") IN ('PENDING', 'UNDER_REVIEW')
      ) OR EXISTS (
        SELECT 1 FROM "users" u WHERE u."id" = c."userId" AND (
          u."isBanned" = true OR u."safetyRestrictedUntil" > CURRENT_TIMESTAMP OR u."safetySuspendedUntil" > CURRENT_TIMESTAMP
        )
      )
    )
  `);
  const candidates = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT c."id", c."postId", c."userId", p."content", p."metadata", c."impressionsCount", c."createdAt"
    FROM "premium_post_boost_campaigns" c
    JOIN "posts" p ON p."id" = c."postId"
    WHERE c."status" = 'active' AND c."startsAt" <= CURRENT_TIMESTAMP AND c."endsAt" > CURRENT_TIMESTAMP
      AND p."isActive" = true AND p."visibility" = 'public'
      AND c."userId" <> ${input.viewerId}
    ORDER BY c."impressionsCount" ASC, c."createdAt" ASC
    LIMIT 25
  `);
  const blocked = new Set(input.blockedAuthorIds || []);
  const [connections, follows, profile, semanticScores] = await Promise.all([
    prismaRead.connections.findMany({
      where: { status: 'accepted', OR: [{ requesterId: input.viewerId }, { addresseeId: input.viewerId }] },
      select: { requesterId: true, addresseeId: true }, take: 500,
    }),
    prismaRead.follows.findMany({ where: { followerId: input.viewerId }, select: { followingId: true }, take: 500 }),
    prismaRead.user.findUnique({
      where: { id: input.viewerId },
      select: { interests: true, skills: { select: { skill: { select: { name: true } } } } },
    }),
    loadCachedSemanticScores(input.viewerId, 'post', candidates.map((candidate) => String(candidate.postId))),
  ]);
  const network = new Set([
    ...follows.map((follow) => follow.followingId),
    ...connections.flatMap((connection) => [connection.requesterId, connection.addresseeId]),
  ]);
  const tokens = [...(profile?.interests || []), ...(profile?.skills || []).map((entry) => entry.skill.name)]
    .map((value) => value.toLowerCase()).filter(Boolean);
  const scored = candidates.map((candidate) => {
    const text = `${candidate.content || ''} ${JSON.stringify(candidate.metadata || {})}`.toLowerCase();
    const lexical = tokens.length > 0
      ? Math.min(1, tokens.filter((token) => text.includes(token)).length / Math.min(5, tokens.length))
      : 0;
    const semantic = semanticScores.get(String(candidate.postId)) ?? lexical;
    const graph = network.has(String(candidate.userId)) ? 1 : 0;
    return { ...candidate, targetingScore: 0.65 * semantic + 0.35 * graph };
  }).filter((candidate) => candidate.targetingScore > 0)
    .sort((left, right) => right.targetingScore - left.targetingScore
      || Number(left.impressionsCount || 0) - Number(right.impressionsCount || 0)
      || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  for (const candidate of scored) {
    if (blocked.has(candidate.userId)) continue;
    const counts = await prismaRead.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count" FROM "recommendation_events"
      WHERE "userId" = ${input.viewerId} AND "entityType" = 'POST' AND "entityId" = ${candidate.postId}
        AND "isBoosted" = true AND "qualifiedExposure" = true
        AND "occurredAt" >= date_trunc('day', CURRENT_TIMESTAMP)
    `);
    if (Number(counts[0]?.count || 0) >= 3) continue;
    return [{ type: 'BOOSTED_POST', position: 9, campaignId: candidate.id, postId: candidate.postId, label: 'Boosted' }];
  }
  return [];
}

export async function recordBoostDelivery(input: {
  campaignId: string;
  eventType: 'impression' | 'click' | 'meaningful' | 'negative';
}): Promise<void> {
  const column = input.eventType === 'impression'
    ? Prisma.raw('"impressionsCount"')
    : input.eventType === 'click'
      ? Prisma.raw('"clicksCount"')
      : input.eventType === 'meaningful'
        ? Prisma.raw('"meaningfulActionsCount"')
        : Prisma.raw('"negativeFeedbackCount"');
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "premium_post_boost_campaigns"
    SET ${column} = ${column} + 1,
        "deliveredFirstImpressionAt" = CASE WHEN ${input.eventType} = 'impression' THEN COALESCE("deliveredFirstImpressionAt", CURRENT_TIMESTAMP) ELSE "deliveredFirstImpressionAt" END,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${input.campaignId}
  `);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "premium_post_boost_campaigns"
    SET "status" = 'paused', "pauseReason" = 'NEGATIVE_FEEDBACK_RATE', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${input.campaignId} AND "status" = 'active' AND "impressionsCount" >= 100
      AND "negativeFeedbackCount"::double precision / NULLIF("impressionsCount", 0) > 0.03
  `);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "premium_post_boost_campaigns" c
    SET "status" = 'paused', "pauseReason" = 'SAFETY', "updatedAt" = CURRENT_TIMESTAMP
    WHERE c."id" = ${input.campaignId} AND c."status" = 'active' AND (
      EXISTS (
        SELECT 1 FROM "moderation_reports" mr
        WHERE mr."reportedPostId" = c."postId" AND upper(mr."status") IN ('PENDING', 'UNDER_REVIEW')
      ) OR EXISTS (
        SELECT 1 FROM "users" u WHERE u."id" = c."userId" AND (
          u."isBanned" = true OR u."safetyRestrictedUntil" > CURRENT_TIMESTAMP OR u."safetySuspendedUntil" > CURRENT_TIMESTAMP
        )
      )
    )
  `);
}

export async function maintainPostBoostCampaigns(): Promise<{ completed: number; safetyPaused: number }> {
  const completed = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "premium_post_boost_campaigns"
    SET "status" = 'completed', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "status" = 'active' AND "endsAt" <= CURRENT_TIMESTAMP
    RETURNING "id"
  `);
  const safetyPaused = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "premium_post_boost_campaigns" c
    SET "status" = 'paused', "pauseReason" = 'SAFETY', "updatedAt" = CURRENT_TIMESTAMP
    WHERE c."status" = 'active' AND (
      EXISTS (
        SELECT 1 FROM "moderation_reports" mr
        WHERE mr."reportedPostId" = c."postId" AND upper(mr."status") IN ('PENDING', 'UNDER_REVIEW')
      ) OR EXISTS (
        SELECT 1 FROM "users" u WHERE u."id" = c."userId" AND (
          u."isBanned" = true OR u."safetyRestrictedUntil" > CURRENT_TIMESTAMP OR u."safetySuspendedUntil" > CURRENT_TIMESTAMP
        )
      )
    )
    RETURNING "id"
  `);
  return { completed: completed.length, safetyPaused: safetyPaused.length };
}

/** Operations-only recovery path. Cancellation and safety pauses never call this. */
export async function refundUndeliveredPlatformFailure(campaignId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const campaigns = await tx.$queryRaw<any[]>(Prisma.sql`
      SELECT "id", "creditWindowId", "impressionsCount", "deliveredFirstImpressionAt", "status"
      FROM "premium_post_boost_campaigns" WHERE "id" = ${campaignId} FOR UPDATE
    `);
    const campaign = campaigns[0];
    if (
      !campaign || Number(campaign.impressionsCount || 0) > 0 || campaign.deliveredFirstImpressionAt ||
      !['active', 'paused'].includes(String(campaign.status))
    ) return false;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "premium_post_boost_campaigns"
      SET "status" = 'failed', "pauseReason" = 'PLATFORM_FAILURE', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${campaignId}
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "premium_boost_credit_windows"
      SET "creditsConsumed" = GREATEST(0, "creditsConsumed" - 1), "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${campaign.creditWindowId}
    `);
    return true;
  });
}
