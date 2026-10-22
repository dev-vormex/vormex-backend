/**
 * Eligibility filtering — everything the viewer must not see, resolved before a
 * single score is computed.
 *
 * Two independent layers protect the viewer, and both are server-side:
 *
 *   1. This module removes candidates by identity (blocked, banned, hidden,
 *      not-interested, self-reported, proven-harmful).
 *   2. Hydration re-applies `buildPostVisibilityWhere`, the same authorisation
 *      gate the rest of the API uses. Even if a candidate generator had a bug,
 *      a post the viewer cannot legitimately access is dropped there.
 *
 * Nothing here relies on the client filtering anything.
 */

import { Prisma } from '@prisma/client';
import { prismaRead } from '../../../../config/prisma';
import { getBlockedUserIds } from '../../../safety/services/trust-safety.service';
import { getFeedConfig } from './feed-config';
import type { FeedCandidate, FeedEligibilityContext } from './feed-types';

const MAX_TRACKED_EXCLUSIONS = 5_000;

function boundedSet(values: Array<string | null | undefined>): Set<string> {
  const output = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    output.add(String(value));
    if (output.size >= MAX_TRACKED_EXCLUSIONS) break;
  }
  return output;
}

/**
 * Loads the viewer's exclusion lists.
 *
 * Failures degrade toward *more* filtering, never less: if a lookup throws we
 * keep whatever we did resolve, and the visibility gate at hydration still
 * stands. `getBlockedUserIds` is deliberately awaited without a catch-to-empty —
 * blocking must override ranking, so a feed we cannot prove is block-safe is not
 * served (the caller falls back to the legacy ranker, which applies the same
 * gate).
 */
export async function loadEligibilityContext(
  userId: string,
  nowMs: number = Date.now()
): Promise<FeedEligibilityContext> {
  const config = getFeedConfig();
  const negativeSince = new Date(nowMs - 180 * 86_400_000);

  const blockedUserIds = await getBlockedUserIds(userId);

  const [feedback, reportedPosts, suppressed] = await Promise.all([
    prismaRead.$queryRaw<Array<{ entityId: string; authorId: string | null; feedbackType: string }>>(
      Prisma.sql`
        SELECT "entityId", "authorId", "feedbackType"
        FROM "recommendation_feedback"
        WHERE "userId" = ${userId} AND "isActive" = true AND "entityType" = 'POST'
        LIMIT ${MAX_TRACKED_EXCLUSIONS}
      `
    ).catch(() => []),

    prismaRead.$queryRaw<Array<{ reportedPostId: string }>>(Prisma.sql`
      SELECT DISTINCT "reportedPostId"
      FROM "moderation_reports"
      WHERE "reporterId" = ${userId}
        AND "reportedPostId" IS NOT NULL
        AND "createdAt" >= ${negativeSince}
      LIMIT ${MAX_TRACKED_EXCLUSIONS}
    `).catch(() => []),

    // Posts that reached a meaningful sample and still drew negative feedback
    // above the drop rate are pulled for everyone, not just this viewer.
    prismaRead.$queryRaw<Array<{ entityId: string }>>(Prisma.sql`
      SELECT "entityId"
      FROM "recommendation_item_daily_stats"
      WHERE "entityType" = 'POST'
        AND "day" >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY "entityId"
      HAVING SUM("organicImpressions") >= ${config.antiGaming.negativeFeedbackMinimumImpressions}
         AND SUM("organicNegativeFeedback")::float
             / GREATEST(SUM("organicImpressions"), 1) > ${config.antiGaming.negativeFeedbackDropRate}
      LIMIT ${MAX_TRACKED_EXCLUSIONS}
    `).catch(() => []),
  ]);

  return {
    blockedUserIds: boundedSet(blockedUserIds),
    hiddenAuthorIds: boundedSet(
      feedback.filter((row) => row.feedbackType === 'HIDE_AUTHOR').map((row) => row.authorId)
    ),
    notInterestedPostIds: boundedSet(
      feedback.filter((row) => row.feedbackType === 'NOT_INTERESTED').map((row) => row.entityId)
    ),
    bannedAuthorIds: new Set<string>(),
    ownPostIds: new Set<string>(),
    suppressedPostIds: boundedSet([
      ...reportedPosts.map((row) => row.reportedPostId),
      ...suppressed.map((row) => row.entityId),
    ]),
  };
}

/** Author ids to exclude at the SQL layer, so excluded posts are never fetched. */
export function excludedAuthorIds(eligibility: FeedEligibilityContext): string[] {
  return Array.from(new Set([...eligibility.blockedUserIds, ...eligibility.hiddenAuthorIds]));
}

export interface EligibilityResult {
  eligible: FeedCandidate[];
  removed: Record<string, number>;
}

/**
 * Applies exclusions to merged candidates.
 *
 * Runs before scoring so that a "not interested" post costs nothing, and so the
 * removal reasons can be counted for the §27 metrics.
 */
export function filterEligibleCandidates(
  candidates: Iterable<FeedCandidate>,
  eligibility: FeedEligibilityContext,
  options: { nowMs?: number; maxAgeHours?: number } = {}
): EligibilityResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeHours = options.maxAgeHours ?? getFeedConfig().freshness.maxAgeHours;
  const oldestAllowedMs = nowMs - maxAgeHours * 3_600_000;

  const eligible: FeedCandidate[] = [];
  const removed: Record<string, number> = {};
  const bump = (reason: string) => {
    removed[reason] = (removed[reason] || 0) + 1;
  };

  for (const candidate of candidates) {
    if (eligibility.blockedUserIds.has(candidate.authorId)) {
      bump('blocked');
      continue;
    }
    if (eligibility.bannedAuthorIds.has(candidate.authorId)) {
      bump('bannedAuthor');
      continue;
    }
    if (eligibility.hiddenAuthorIds.has(candidate.authorId)) {
      bump('hiddenAuthor');
      continue;
    }
    if (eligibility.notInterestedPostIds.has(candidate.postId)) {
      bump('notInterested');
      continue;
    }
    if (eligibility.suppressedPostIds.has(candidate.postId)) {
      bump('suppressed');
      continue;
    }

    const createdAtMs = candidate.createdAt instanceof Date
      ? candidate.createdAt.getTime()
      : new Date(candidate.createdAt).getTime();
    if (Number.isFinite(createdAtMs) && createdAtMs < oldestAllowedMs) {
      bump('tooOld');
      continue;
    }

    eligible.push(candidate);
  }

  return { eligible, removed };
}
