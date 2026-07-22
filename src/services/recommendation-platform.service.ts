import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, prismaRead } from '../config/prisma';
import { isRedisEnabled, redisCommand } from '../infrastructure/redis/client';
import {
  RECOMMENDATION_RANKER_VERSION,
  assignRecommendationVariant,
  qualifiesExposure,
  type RecommendationEntityType,
  type RecommendationSurface,
} from './recommendation-engine.service';

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_VALIDATION_MS = 7 * 24 * 60 * 60 * 1000;
const RAW_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CURSOR_VERSION = 1;

export interface RecommendationSnapshotItem {
  entityType: RecommendationEntityType;
  entityId: string;
  position: number;
  reasonCode: string;
  reasonText: string;
  source: string;
  isBoosted?: boolean;
  authorId?: string | null;
  examinationPropensity?: number;
  features?: Record<string, number | null | undefined>;
  campaignId?: string;
  socialActors?: Array<{ id: string; name: string; profileImage?: string | null }>;
}

export interface RecommendationSessionSnapshot {
  id: string;
  userId: string;
  surface: RecommendationSurface;
  requestId: string;
  snapshotAt: string;
  expiresAt: string;
  validationUntil: string;
  rankerVersion: string;
  experimentVariant: string;
  orderedItems: RecommendationSnapshotItem[];
  modulePlacements: unknown[];
}

export interface RecommendationEnvelope {
  recommendationSessionId: string;
  requestId: string;
  rankerVersion: string;
  experimentVariant: string;
  nextCursor: string | null;
}

interface CursorPayload {
  v: number;
  sid: string;
  uid: string;
  surface: RecommendationSurface;
  offset: number;
  snapshotAt: string;
  rankerVersion: string;
  experimentVariant: string;
}

export interface ClientRecommendationEvent {
  eventId: string;
  eventType: string;
  recommendationSessionId: string;
  requestId?: string | null;
  surface: RecommendationSurface;
  entityType: RecommendationEntityType;
  entityId: string;
  reportedPosition?: number | null;
  maxVisibleFraction?: number | null;
  visibleTimeMs?: number | null;
  playbackTimeMs?: number | null;
  mediaDurationMs?: number | null;
  occurredAt: string;
  metadata?: Record<string, unknown> | null;
}

const allowedSurfaces = new Set<RecommendationSurface>(['HOME', 'REELS', 'STORIES', 'PEOPLE', 'JOBS', 'EVENTS']);
const allowedEntityTypes = new Set<RecommendationEntityType>(['POST', 'REEL', 'STORY', 'PERSON', 'JOB', 'EVENT']);
const allowedEventTypes = new Set([
  'VISIBILITY',
  'PLAYBACK',
  'STORY_VIEW',
  'EXPAND',
  'DETAIL_OPEN',
  'PROFILE_OPEN',
  'SKIP',
]);

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function cursorSecret(): string {
  const secret = process.env.RECOMMENDATION_CURSOR_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RECOMMENDATION_CURSOR_SECRET or JWT_SECRET is required in production');
  }
  return 'vormex-local-recommendation-cursor-secret';
}

function signCursorPayload(encodedPayload: string): string {
  return createHmac('sha256', cursorSecret()).update(encodedPayload).digest('base64url');
}

export function encodeRecommendationCursor(payload: CursorPayload): string {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${signCursorPayload(encoded)}`;
}

export function decodeRecommendationCursor(cursor: string): CursorPayload | null {
  try {
    const [encoded, signature, extra] = String(cursor || '').split('.');
    if (!encoded || !signature || extra) return null;
    const expected = Buffer.from(signCursorPayload(encoded));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(base64UrlDecode(encoded)) as CursorPayload;
    if (
      payload.v !== CURSOR_VERSION ||
      !payload.sid ||
      !payload.uid ||
      !allowedSurfaces.has(payload.surface) ||
      !Number.isInteger(payload.offset) ||
      payload.offset < 0
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCacheKey(sessionId: string): string {
  return `recommendation:session:${sessionId}`;
}

function normalizeSnapshot(row: any): RecommendationSessionSnapshot {
  return {
    id: String(row.id),
    userId: String(row.userId),
    surface: String(row.surface) as RecommendationSurface,
    requestId: String(row.requestId),
    snapshotAt: new Date(row.snapshotAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    validationUntil: new Date(row.validationUntil).toISOString(),
    rankerVersion: String(row.rankerVersion),
    experimentVariant: String(row.experimentVariant),
    orderedItems: Array.isArray(row.orderedItems) ? row.orderedItems : [],
    modulePlacements: Array.isArray(row.modulePlacements) ? row.modulePlacements : [],
  };
}

async function cacheSnapshot(snapshot: RecommendationSessionSnapshot): Promise<void> {
  if (!isRedisEnabled() || !redisCommand) return;
  await redisCommand.set(sessionCacheKey(snapshot.id), JSON.stringify(snapshot), 'PX', SESSION_TTL_MS);
}

export async function loadRecommendationSession(
  sessionId: string,
  options: { allowExpiredForValidation?: boolean } = {}
): Promise<RecommendationSessionSnapshot | null> {
  if (isRedisEnabled() && redisCommand) {
    try {
      const cached = await redisCommand.get(sessionCacheKey(sessionId));
      if (cached) return normalizeSnapshot(JSON.parse(cached));
    } catch {
      // PostgreSQL is the correctness fallback.
    }
  }

  const timeColumn = options.allowExpiredForValidation ? Prisma.sql`"validationUntil"` : Prisma.sql`"expiresAt"`;
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "recommendation_sessions"
    WHERE "id" = ${sessionId} AND ${timeColumn} > CURRENT_TIMESTAMP
    LIMIT 1
  `);
  if (!rows[0]) return null;
  const snapshot = normalizeSnapshot(rows[0]);
  if (!options.allowExpiredForValidation) void cacheSnapshot(snapshot).catch(() => undefined);
  return snapshot;
}

export async function createRecommendationSession(input: {
  userId: string;
  surface: RecommendationSurface;
  orderedItems: RecommendationSnapshotItem[];
  pageSize: number;
  modulePlacements?: unknown[];
  snapshotAt?: Date;
  rankerVersion?: string;
  experimentVariant?: string;
}): Promise<{ snapshot: RecommendationSessionSnapshot; envelope: RecommendationEnvelope; items: RecommendationSnapshotItem[] }> {
  const now = input.snapshotAt || new Date();
  const id = randomUUID();
  const requestId = randomUUID();
  const rankerVersion = input.rankerVersion || RECOMMENDATION_RANKER_VERSION;
  const experimentVariant = input.experimentVariant || assignRecommendationVariant(input.userId);
  const orderedItems = input.orderedItems.map((item, index) => ({ ...item, position: index + 1 }));
  const snapshot: RecommendationSessionSnapshot = {
    id,
    userId: input.userId,
    surface: input.surface,
    requestId,
    snapshotAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    validationUntil: new Date(now.getTime() + SESSION_VALIDATION_MS).toISOString(),
    rankerVersion,
    experimentVariant,
    orderedItems,
    modulePlacements: input.modulePlacements || [],
  };

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "recommendation_sessions"
      ("id", "userId", "surface", "requestId", "snapshotAt", "expiresAt", "validationUntil",
       "rankerVersion", "experimentVariant", "orderedItems", "modulePlacements", "createdAt")
    VALUES
      (${snapshot.id}, ${snapshot.userId}, ${snapshot.surface}, ${snapshot.requestId}, ${now},
       ${new Date(snapshot.expiresAt)}, ${new Date(snapshot.validationUntil)}, ${snapshot.rankerVersion},
       ${snapshot.experimentVariant}, ${JSON.stringify(snapshot.orderedItems)}::jsonb,
       ${JSON.stringify(snapshot.modulePlacements)}::jsonb, CURRENT_TIMESTAMP)
  `);
  void cacheSnapshot(snapshot).catch(() => undefined);

  const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize)));
  const nextCursor = orderedItems.length > pageSize
    ? encodeRecommendationCursor({
        v: CURSOR_VERSION,
        sid: id,
        uid: input.userId,
        surface: input.surface,
        offset: pageSize,
        snapshotAt: snapshot.snapshotAt,
        rankerVersion,
        experimentVariant,
      })
    : null;
  return {
    snapshot,
    items: orderedItems.slice(0, pageSize),
    envelope: {
      recommendationSessionId: id,
      requestId,
      rankerVersion,
      experimentVariant,
      nextCursor,
    },
  };
}

export async function getRecommendationSessionPage(input: {
  cursor: string;
  userId: string;
  surface: RecommendationSurface;
  pageSize: number;
}): Promise<{ snapshot: RecommendationSessionSnapshot; envelope: RecommendationEnvelope; items: RecommendationSnapshotItem[] } | null> {
  const cursor = decodeRecommendationCursor(input.cursor);
  if (!cursor || cursor.uid !== input.userId || cursor.surface !== input.surface) return null;
  const snapshot = await loadRecommendationSession(cursor.sid);
  if (!snapshot || snapshot.userId !== input.userId || snapshot.surface !== input.surface) return null;
  if (
    snapshot.snapshotAt !== cursor.snapshotAt ||
    snapshot.rankerVersion !== cursor.rankerVersion ||
    snapshot.experimentVariant !== cursor.experimentVariant
  ) return null;

  const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize)));
  const nextOffset = cursor.offset + pageSize;
  const nextCursor = nextOffset < snapshot.orderedItems.length
    ? encodeRecommendationCursor({ ...cursor, offset: nextOffset })
    : null;
  return {
    snapshot,
    items: snapshot.orderedItems.slice(cursor.offset, nextOffset),
    envelope: {
      recommendationSessionId: snapshot.id,
      requestId: snapshot.requestId,
      rankerVersion: snapshot.rankerVersion,
      experimentVariant: snapshot.experimentVariant,
      nextCursor,
    },
  };
}

function isQualifiedPositive(event: ClientRecommendationEvent, qualifiedExposure: boolean): boolean {
  if (['EXPAND', 'DETAIL_OPEN', 'PROFILE_OPEN'].includes(event.eventType)) return true;
  if (!qualifiedExposure) return false;
  if (event.surface === 'REELS') {
    const duration = Math.max(0, Number(event.mediaDurationMs || 0));
    return Number(event.playbackTimeMs || 0) >= Math.max(6_000, duration * 0.5);
  }
  if (event.surface === 'STORIES') {
    const duration = Math.max(0, Number(event.mediaDurationMs || 0));
    return duration > 0 && Number(event.visibleTimeMs || 0) >= duration * 0.9;
  }
  return Number(event.visibleTimeMs || 0) >= 5_000;
}

function validateClientEvent(event: ClientRecommendationEvent): string | null {
  if (!event || typeof event !== 'object') return 'INVALID_EVENT';
  if (!/^[0-9a-f-]{16,64}$/i.test(String(event.eventId || ''))) return 'INVALID_EVENT_ID';
  if (!allowedEventTypes.has(String(event.eventType || '').toUpperCase())) return 'INVALID_EVENT_TYPE';
  if (!allowedSurfaces.has(event.surface)) return 'INVALID_SURFACE';
  if (!allowedEntityTypes.has(event.entityType)) return 'INVALID_ENTITY_TYPE';
  if (!event.entityId || !event.recommendationSessionId) return 'MISSING_SESSION_OR_ENTITY';
  if (String(event.entityId).length > 128 || String(event.recommendationSessionId).length > 128) return 'IDENTIFIER_TOO_LONG';
  if (event.requestId != null && String(event.requestId).length > 128) return 'REQUEST_ID_TOO_LONG';
  if (event.reportedPosition != null && (!Number.isInteger(event.reportedPosition) || event.reportedPosition < 1 || event.reportedPosition > 10_000)) {
    return 'INVALID_REPORTED_POSITION';
  }
  if (event.maxVisibleFraction != null && (!Number.isFinite(event.maxVisibleFraction) || event.maxVisibleFraction < 0 || event.maxVisibleFraction > 1)) {
    return 'INVALID_VISIBLE_FRACTION';
  }
  for (const value of [event.visibleTimeMs, event.playbackTimeMs, event.mediaDurationMs]) {
    if (value != null && (!Number.isInteger(value) || value < 0 || value > 86_400_000)) return 'INVALID_DURATION';
  }
  const occurredAt = new Date(event.occurredAt).getTime();
  if (!Number.isFinite(occurredAt)) return 'INVALID_OCCURRED_AT';
  if (occurredAt > Date.now() + 5 * 60 * 1000 || occurredAt < Date.now() - RAW_EVENT_RETENTION_MS) return 'OCCURRED_AT_OUT_OF_RANGE';
  return null;
}

export async function ingestRecommendationEvents(
  userId: string,
  rawEvents: ClientRecommendationEvent[]
): Promise<{ accepted: number; duplicate: number; rejected: number; errors: Array<{ eventId?: string; code: string }> }> {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > 100) {
    throw new Error('events must contain between 1 and 100 items');
  }

  const errors: Array<{ eventId?: string; code: string }> = [];
  let accepted = 0;
  let duplicates = 0;
  const sessions = new Map<string, RecommendationSessionSnapshot | null>();

  for (const original of rawEvents) {
    const event = { ...original, eventType: String(original?.eventType || '').toUpperCase() };
    const validationError = validateClientEvent(event);
    if (validationError) {
      errors.push({ eventId: event?.eventId, code: validationError });
      continue;
    }

    if (!sessions.has(event.recommendationSessionId)) {
      sessions.set(
        event.recommendationSessionId,
        await loadRecommendationSession(event.recommendationSessionId, { allowExpiredForValidation: true })
      );
    }
    const snapshot = sessions.get(event.recommendationSessionId);
    if (!snapshot || snapshot.userId !== userId || snapshot.surface !== event.surface) {
      errors.push({ eventId: event.eventId, code: 'INVALID_SESSION' });
      continue;
    }
    const moduleEntityType: Record<string, RecommendationEntityType> = {
      BOOSTED_POST: 'POST', PEOPLE: 'PERSON', REELS: 'REEL', JOBS: 'JOB', EVENTS: 'EVENT',
    };
    const moduleItems = snapshot.modulePlacements.flatMap((placement: any) => {
      const placementType = String(placement?.type || '').toUpperCase();
      const entityType = moduleEntityType[placementType];
      if (!entityType) return [];
      const values = placementType === 'BOOSTED_POST'
        ? [{ id: placement.postId }]
        : Array.isArray(placement.items) ? placement.items : [];
      return values.map((value: any) => ({
        entityType,
        entityId: String(value?.id || ''),
        position: Number(placement.position || 0),
        reasonCode: String(placement.reasonCode || `${placementType}_MODULE`),
        reasonText: String(placement.reasonText || 'Recommended for you'),
        source: placementType === 'BOOSTED_POST' ? 'PREMIUM_BOOST' : `HOME_${placementType}_MODULE`,
        isBoosted: placementType === 'BOOSTED_POST',
        campaignId: placementType === 'BOOSTED_POST' ? String(placement.campaignId || '') : undefined,
        examinationPropensity: undefined,
        features: undefined,
      } satisfies RecommendationSnapshotItem));
    });
    const canonical: RecommendationSnapshotItem | undefined = snapshot.orderedItems.find((item) => item.entityType === event.entityType && item.entityId === event.entityId)
      || moduleItems.find((item) => item.entityType === event.entityType && item.entityId === event.entityId);
    if (!canonical) {
      errors.push({ eventId: event.eventId, code: 'ENTITY_NOT_IN_SESSION' });
      continue;
    }

    const qualifiedExposure = ['VISIBILITY', 'PLAYBACK', 'STORY_VIEW'].includes(event.eventType) && qualifiesExposure(event);
    const qualifiedPositive = isQualifiedPositive(event, qualifiedExposure);
    // A viewport exposure is the denominator, not engagement. Quality dwell/taps/expands
    // become engagement through isQualifiedPositive; transactional likes are added separately.
    const cascadeEngagement = qualifiedPositive;
    const metadata = {
      ...(event.metadata || {}),
      rankingFeatures: canonical.features || null,
      campaignId: canonical.campaignId || null,
      positionMismatch: event.reportedPosition != null && Number(event.reportedPosition) !== canonical.position,
    };

    const inserted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "recommendation_events"
        ("id", "eventId", "userId", "eventType", "surface", "entityType", "entityId", "requestId",
         "recommendationSessionId", "reportedPosition", "position", "maxVisibleFraction", "visibleTimeMs",
         "playbackTimeMs", "mediaDurationMs", "occurredAt", "qualifiedExposure", "cascadeEngagement",
         "qualifiedPositive", "meaningfulOutcome", "isBoosted", "rankerVersion", "experimentVariant",
         "examinationPropensity", "metadata")
      VALUES
        (${randomUUID()}, ${event.eventId}, ${userId}, ${event.eventType}, ${event.surface}, ${event.entityType},
         ${event.entityId}, ${event.requestId || snapshot.requestId}, ${snapshot.id}, ${event.reportedPosition ?? null},
         ${canonical.position}, ${event.maxVisibleFraction ?? null}, ${event.visibleTimeMs ?? null},
         ${event.playbackTimeMs ?? null}, ${event.mediaDurationMs ?? null}, ${new Date(event.occurredAt)},
         ${qualifiedExposure}, ${cascadeEngagement}, ${qualifiedPositive}, false, ${Boolean(canonical.isBoosted)},
         ${snapshot.rankerVersion}, ${snapshot.experimentVariant}, ${canonical.examinationPropensity ?? null},
         ${JSON.stringify(metadata)}::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `);
    if (inserted.length === 0) {
      duplicates += 1;
    } else {
      accepted += 1;
      if (canonical.isBoosted && canonical.campaignId && qualifiedExposure) {
        void import('./premium-post-boost.service')
          .then(({ recordBoostDelivery }) => recordBoostDelivery({ campaignId: canonical.campaignId!, eventType: 'impression' }))
          .catch(() => undefined);
      }
    }
  }

  return { accepted, duplicate: duplicates, rejected: errors.length, errors };
}

export async function getRecommendationPreferences(userId: string): Promise<{
  personalizedRecommendationsEnabled: boolean;
  activityRecommendationsEnabled: boolean;
  namedActivityLegalBasisApproved: boolean;
}> {
  const rows = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT "personalizedRecommendationsEnabled", "activityRecommendationsEnabled"
    FROM "recommendation_user_profiles" WHERE "userId" = ${userId} LIMIT 1
  `);
  return {
    personalizedRecommendationsEnabled: rows[0]?.personalizedRecommendationsEnabled ?? true,
    activityRecommendationsEnabled: rows[0]?.activityRecommendationsEnabled ?? true,
    namedActivityLegalBasisApproved: process.env.NAMED_ACTIVITY_RECOMMENDATIONS_LEGAL_BASIS_APPROVED === 'true',
  };
}

export async function updateRecommendationPreferences(userId: string, input: {
  personalizedRecommendationsEnabled?: boolean;
  activityRecommendationsEnabled?: boolean;
}): Promise<Awaited<ReturnType<typeof getRecommendationPreferences>>> {
  if (input.personalizedRecommendationsEnabled === undefined && input.activityRecommendationsEnabled === undefined) {
    throw new Error('At least one preference is required');
  }
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "recommendation_user_profiles"
      ("id", "userId", "personalizedRecommendationsEnabled", "activityRecommendationsEnabled", "updatedAt")
    VALUES
      (${randomUUID()}, ${userId}, ${input.personalizedRecommendationsEnabled ?? true},
       ${input.activityRecommendationsEnabled ?? true}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId") DO UPDATE SET
      "personalizedRecommendationsEnabled" = COALESCE(${input.personalizedRecommendationsEnabled ?? null}, "recommendation_user_profiles"."personalizedRecommendationsEnabled"),
      "activityRecommendationsEnabled" = COALESCE(${input.activityRecommendationsEnabled ?? null}, "recommendation_user_profiles"."activityRecommendationsEnabled"),
      "updatedAt" = CURRENT_TIMESTAMP
  `);
  return getRecommendationPreferences(userId);
}

export async function updateRecommendationFeedback(userId: string, input: {
  action: 'NOT_INTERESTED' | 'HIDE_AUTHOR' | 'UNDO';
  entityType: RecommendationEntityType;
  entityId: string;
  authorId?: string | null;
  feedbackType?: 'NOT_INTERESTED' | 'HIDE_AUTHOR';
}): Promise<{ active: boolean; feedbackType: string }> {
  const feedbackType = input.action === 'UNDO' ? String(input.feedbackType || 'NOT_INTERESTED') : input.action;
  if (!['NOT_INTERESTED', 'HIDE_AUTHOR'].includes(feedbackType)) throw new Error('Invalid feedback type');
  if (feedbackType === 'HIDE_AUTHOR' && !input.authorId) throw new Error('authorId is required for HIDE_AUTHOR');
  const active = input.action !== 'UNDO';
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "recommendation_feedback"
      ("id", "userId", "entityType", "entityId", "authorId", "feedbackType", "isActive", "updatedAt")
    VALUES
      (${randomUUID()}, ${userId}, ${input.entityType}, ${input.entityId}, ${input.authorId || null},
       ${feedbackType}, ${active}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "entityType", "entityId", "feedbackType") DO UPDATE SET
      "authorId" = EXCLUDED."authorId", "isActive" = EXCLUDED."isActive", "updatedAt" = CURRENT_TIMESTAMP
  `);
  return { active, feedbackType };
}

export async function recordAuthoritativeRecommendationOutcome(input: {
  userId: string;
  entityType: RecommendationEntityType;
  entityId: string;
  eventType: string;
  meaningfulOutcome: boolean;
  attributionWindowHours?: number;
}): Promise<void> {
  const attributionWindowHours = Math.max(1, Math.min(168, Number(input.attributionWindowHours || 24)));
  const exposures = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT * FROM "recommendation_events"
    WHERE "userId" = ${input.userId}
      AND "entityType" = ${input.entityType}
      AND "entityId" = ${input.entityId}
      AND "qualifiedExposure" = true
      AND "occurredAt" >= CURRENT_TIMESTAMP - (${attributionWindowHours} * INTERVAL '1 hour')
    ORDER BY "occurredAt" DESC LIMIT 1
  `);
  const exposure = exposures[0];
  if (!exposure) return;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "recommendation_events"
      ("id", "eventId", "userId", "eventType", "surface", "entityType", "entityId", "requestId",
       "recommendationSessionId", "position", "occurredAt", "cascadeEngagement", "qualifiedPositive",
       "meaningfulOutcome", "isBoosted", "rankerVersion", "experimentVariant")
    VALUES
      (${randomUUID()}, ${randomUUID()}, ${input.userId}, ${input.eventType}, ${exposure.surface}, ${input.entityType},
       ${input.entityId}, ${exposure.requestId}, ${exposure.recommendationSessionId}, ${exposure.position}, CURRENT_TIMESTAMP,
       ${input.eventType !== 'NEGATIVE_FEEDBACK'}, ${input.meaningfulOutcome}, ${input.meaningfulOutcome}, ${exposure.isBoosted}, ${exposure.rankerVersion},
       ${exposure.experimentVariant})
  `);
  if (exposure.isBoosted && exposure.metadata?.campaignId) {
    const eventType = input.eventType === 'NEGATIVE_FEEDBACK'
      ? 'negative'
      : input.meaningfulOutcome ? 'meaningful' : 'click';
    void import('./premium-post-boost.service')
      .then(({ recordBoostDelivery }) => recordBoostDelivery({ campaignId: String(exposure.metadata.campaignId), eventType }))
      .catch(() => undefined);
  }
}

export async function cleanupRecommendationData(now = new Date()): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRaw(Prisma.sql`DELETE FROM "recommendation_events" WHERE "occurredAt" < ${new Date(now.getTime() - RAW_EVENT_RETENTION_MS)}`),
    prisma.$executeRaw(Prisma.sql`DELETE FROM "recommendation_sessions" WHERE "validationUntil" < ${now}`),
    prisma.$executeRaw(Prisma.sql`DELETE FROM "recommendation_item_daily_stats" WHERE "day" < ${new Date(now.getTime() - 13 * 31 * 24 * 60 * 60 * 1000)}`),
  ]);
}
