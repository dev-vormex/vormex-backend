/**
 * FeedImpressionService — the write side of "what did the viewer actually see".
 *
 * Served rows are candidates, not impressions. The feed returns far more posts
 * than anyone scrolls through, so counting served rows would demote posts nobody
 * ever looked at and make the ranker progressively wrong. Only the client can
 * say what entered the viewport, so only the client reports it.
 *
 * What the client cannot do is influence ranking. It ships observations
 * (position, source, dwell) that are stored and used offline; ordering stays
 * entirely server-side.
 */

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../config/prisma';

/** Minimum on-screen time before a view counts, matching the HOME surface rule. */
export const MIN_QUALIFYING_VISIBLE_MS = 1_000;
export const MAX_IMPRESSION_BATCH = 100;
/** Guards against a stuck timer reporting an eight-hour "read". */
export const MAX_RECORDED_DWELL_MS = 5 * 60_000;

const IMPRESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let lastCleanupAt = 0;

export interface FeedImpressionInput {
  postId: string;
  creatorId?: string | null;
  position?: number | null;
  candidateSource?: string | null;
  rankingScore?: number | null;
  rankingVersion?: string | null;
  feedSessionId?: string | null;
  /** Time the card was at least half visible. Omitted by legacy clients. */
  visibleMs?: number | null;
  dwellMs?: number | null;
}

interface NormalizedImpression {
  postId: string;
  creatorId: string | null;
  position: number | null;
  candidateSource: string | null;
  rankingScore: number | null;
  rankingVersion: string | null;
  feedSessionId: string | null;
  dwellMs: number | null;
}

function identifier(value: unknown, maxLength = 128): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function boundedFloat(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Accepts both payload shapes.
 *
 * Legacy: `{ postIds: string[] }` — still sent by shipped app versions, and must
 * keep working. Rich: `{ impressions: [...] }` with viewport and ranking detail.
 * Duplicate post ids inside one batch collapse to the richest entry.
 */
export function normalizeImpressionPayload(body: unknown): NormalizedImpression[] {
  const payload = (body || {}) as Record<string, unknown>;
  const raw: FeedImpressionInput[] = [];

  if (Array.isArray(payload.postIds)) {
    for (const value of payload.postIds) {
      const postId = identifier(value);
      if (postId) raw.push({ postId });
    }
  }

  if (Array.isArray(payload.impressions)) {
    const sessionId = identifier(payload.feedSessionId);
    const version = identifier(payload.rankingVersion, 64);
    for (const value of payload.impressions) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      const postId = identifier(entry.postId);
      if (!postId) continue;

      raw.push({
        postId,
        creatorId: identifier(entry.creatorId),
        position: boundedInt(entry.position, 1, 10_000),
        candidateSource: identifier(entry.candidateSource ?? entry.source, 40),
        rankingScore: boundedFloat(entry.rankingScore ?? entry.score, -1_000_000, 1_000_000),
        rankingVersion: identifier(entry.rankingVersion, 64) ?? version,
        feedSessionId: identifier(entry.feedSessionId) ?? sessionId,
        visibleMs: boundedInt(entry.visibleMs, 0, 86_400_000),
        dwellMs: boundedInt(entry.dwellMs, 0, 86_400_000),
      });
    }
  }

  const byPostId = new Map<string, NormalizedImpression>();
  for (const entry of raw) {
    // A client that reports visibility must clear the bar; one that reports
    // nothing is trusted, because older builds have no timer to report.
    if (entry.visibleMs !== null && entry.visibleMs !== undefined && entry.visibleMs < MIN_QUALIFYING_VISIBLE_MS) {
      continue;
    }

    const normalized: NormalizedImpression = {
      postId: entry.postId,
      creatorId: entry.creatorId ?? null,
      position: entry.position ?? null,
      candidateSource: entry.candidateSource ?? null,
      rankingScore: entry.rankingScore ?? null,
      rankingVersion: entry.rankingVersion ?? null,
      feedSessionId: entry.feedSessionId ?? null,
      dwellMs:
        entry.dwellMs === null || entry.dwellMs === undefined
          ? null
          : Math.min(MAX_RECORDED_DWELL_MS, entry.dwellMs),
    };

    const existing = byPostId.get(entry.postId);
    byPostId.set(
      entry.postId,
      existing
        ? {
            ...existing,
            creatorId: normalized.creatorId ?? existing.creatorId,
            position: normalized.position ?? existing.position,
            candidateSource: normalized.candidateSource ?? existing.candidateSource,
            rankingScore: normalized.rankingScore ?? existing.rankingScore,
            rankingVersion: normalized.rankingVersion ?? existing.rankingVersion,
            feedSessionId: normalized.feedSessionId ?? existing.feedSessionId,
            dwellMs: Math.max(existing.dwellMs ?? 0, normalized.dwellMs ?? 0) || null,
          }
        : normalized
    );

    if (byPostId.size >= MAX_IMPRESSION_BATCH) break;
  }

  return Array.from(byPostId.values());
}

/**
 * Writes impressions, fire-and-forget.
 *
 * Repeat views of the same post update the existing row instead of inserting a
 * duplicate: `seenCount` grows, `dwellMs` accumulates, `firstSeenAt` is
 * preserved. That is what makes "shown four times, never engaged" a signal
 * rather than impression spam.
 */
export function recordFeedImpressions(userId: string, impressions: NormalizedImpression[]): void {
  if (!userId || impressions.length === 0) return;

  const now = new Date();
  const shouldCleanup = now.getTime() - lastCleanupAt > CLEANUP_INTERVAL_MS;
  if (shouldCleanup) lastCleanupAt = now.getTime();

  void (async () => {
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "feed_impressions"
          ("id", "userId", "postId", "seenAt", "creatorId", "feedSessionId", "position",
           "candidateSource", "rankingScore", "rankingVersion", "seenCount", "firstSeenAt", "dwellMs")
        VALUES ${Prisma.join(
          impressions.map(
            (item) => Prisma.sql`(
              ${randomUUID()}, ${userId}, ${item.postId}, ${now}, ${item.creatorId},
              ${item.feedSessionId}, ${item.position}, ${item.candidateSource},
              ${item.rankingScore}, ${item.rankingVersion}, 1, ${now}, ${item.dwellMs}
            )`
          )
        )}
        ON CONFLICT ("userId", "postId") DO UPDATE SET
          "seenAt"          = EXCLUDED."seenAt",
          "seenCount"       = "feed_impressions"."seenCount" + 1,
          "creatorId"       = COALESCE(EXCLUDED."creatorId", "feed_impressions"."creatorId"),
          "feedSessionId"   = COALESCE(EXCLUDED."feedSessionId", "feed_impressions"."feedSessionId"),
          "position"        = COALESCE(EXCLUDED."position", "feed_impressions"."position"),
          "candidateSource" = COALESCE(EXCLUDED."candidateSource", "feed_impressions"."candidateSource"),
          "rankingScore"    = COALESCE(EXCLUDED."rankingScore", "feed_impressions"."rankingScore"),
          "rankingVersion"  = COALESCE(EXCLUDED."rankingVersion", "feed_impressions"."rankingVersion"),
          "firstSeenAt"     = COALESCE("feed_impressions"."firstSeenAt", EXCLUDED."firstSeenAt"),
          "dwellMs"         = LEAST(
                                ${MAX_RECORDED_DWELL_MS},
                                COALESCE("feed_impressions"."dwellMs", 0) + COALESCE(EXCLUDED."dwellMs", 0)
                              )
      `
    );

    if (shouldCleanup) {
      await prisma.$executeRaw(Prisma.sql`
        DELETE FROM "feed_impressions"
        WHERE "seenAt" < ${new Date(now.getTime() - IMPRESSION_RETENTION_MS)}
      `);
    }
  })().catch((error: unknown) => {
    // A dropped impression only costs ranking freshness, never correctness.
    console.error('[feed-v2] failed to write feed impressions:', error);
  });
}

/**
 * Backfills `creatorId` for rows written before the client sent it.
 *
 * Without it the per-creator skip signal stays blind to historical impressions.
 * Bounded per call so it can be run repeatedly from a maintenance job.
 */
export async function backfillImpressionCreatorIds(batchSize = 5_000): Promise<number> {
  const affected = await prisma.$executeRaw(Prisma.sql`
    UPDATE "feed_impressions" fi
    SET "creatorId" = p."authorId"
    FROM "posts" p
    WHERE p."id" = fi."postId"
      AND fi."creatorId" IS NULL
      AND fi."id" IN (
        SELECT "id" FROM "feed_impressions" WHERE "creatorId" IS NULL LIMIT ${batchSize}
      )
  `);
  return Number(affected) || 0;
}
