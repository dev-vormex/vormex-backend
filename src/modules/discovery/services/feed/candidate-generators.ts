/**
 * Candidate generation — the stage the old feed did not have.
 *
 * The previous ranker only ever saw "the newest N posts globally", so every
 * viewer's universe was the same fixed set and reordering it could not produce a
 * different feed. Here each reason a post might belong in your feed is its own
 * bounded pool, run in parallel, then merged and deduplicated.
 *
 * Every generator:
 *   - returns cheap refs (id, author, createdAt), never post bodies;
 *   - is individually capped by `config.limits`;
 *   - fails soft — one broken pool degrades the feed, it never breaks it.
 *
 * Privacy note: pools scoped to the viewer's accepted connections may include
 * `connections`-visibility posts. Every other pool is restricted to public posts.
 * Regardless, the pipeline re-checks visibility server-side at hydration through
 * `buildPostVisibilityWhere`, so a generator bug cannot leak a post.
 */

import { Prisma } from '@prisma/client';
import { prismaRead } from '../../../../config/prisma';
import { getFeedConfig, type CandidateSource, type FeedConfig } from './feed-config';
import type { FeedCandidateRef, FeedViewerContext } from './feed-types';

export interface CandidateGeneratorInput {
  viewer: FeedViewerContext;
  /** Authors excluded up-front (blocked both ways, hidden, banned). */
  excludedAuthorIds: string[];
  nowMs: number;
  config: FeedConfig;
}

export interface CandidateGenerator {
  source: CandidateSource;
  generate(input: CandidateGeneratorInput): Promise<FeedCandidateRef[]>;
}

const PUBLIC_VISIBILITIES = ['public', 'PUBLIC'];
const NETWORK_VISIBILITIES = ['public', 'PUBLIC', 'connections', 'CONNECTIONS'];

type PostRefRow = { id: string; authorId: string; createdAt: Date };

function cutoff(nowMs: number, hours: number): Date {
  return new Date(nowMs - hours * 3_600_000);
}

function toRefs(
  rows: Array<PostRefRow & { sourceScore?: number | string | null }>,
  source: CandidateSource
): FeedCandidateRef[] {
  return rows
    .filter((row) => row?.id && row?.authorId)
    .map((row) => ({
      postId: String(row.id),
      authorId: String(row.authorId),
      createdAt: new Date(row.createdAt),
      source,
      ...(row.sourceScore === undefined || row.sourceScore === null
        ? {}
        : { sourceScore: Number(row.sourceScore) }),
    }));
}

/** Shared author-scoped pool. Used by every "posts from these people" source. */
async function postsByAuthors(input: {
  authorIds: string[];
  excludedAuthorIds: string[];
  visibilities: string[];
  since: Date;
  limit: number;
  source: CandidateSource;
}): Promise<FeedCandidateRef[]> {
  const excluded = new Set(input.excludedAuthorIds);
  const authorIds = input.authorIds.filter((id) => id && !excluded.has(id));
  if (authorIds.length === 0 || input.limit <= 0) return [];

  const rows = await prismaRead.post.findMany({
    where: {
      isActive: true,
      authorId: { in: authorIds },
      visibility: { in: input.visibilities },
      createdAt: { gte: input.since },
    },
    select: { id: true, authorId: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
  });

  return toRefs(rows, input.source);
}

// ---------------------------------------------------------------------------
// Social-graph pools
// ---------------------------------------------------------------------------

const followingGenerator: CandidateGenerator = {
  source: 'FOLLOWING',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    return postsByAuthors({
      authorIds: viewer.followingIds,
      excludedAuthorIds,
      // A followed non-connection cannot see connections-only posts.
      visibilities: PUBLIC_VISIBILITIES,
      since: cutoff(nowMs, config.freshness.maxAgeHours),
      limit: config.limits.following,
      source: 'FOLLOWING',
    });
  },
};

const connectionGenerator: CandidateGenerator = {
  source: 'CONNECTION',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    return postsByAuthors({
      authorIds: viewer.connectionIds,
      excludedAuthorIds,
      visibilities: NETWORK_VISIBILITIES,
      since: cutoff(nowMs, config.freshness.maxAgeHours),
      limit: config.limits.connection,
      source: 'CONNECTION',
    });
  },
};

const recentConnectionGenerator: CandidateGenerator = {
  source: 'RECENT_CONNECTION',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    return postsByAuthors({
      authorIds: viewer.recentConnectionIds,
      excludedAuthorIds,
      visibilities: NETWORK_VISIBILITIES,
      since: cutoff(nowMs, config.freshness.maxAgeHours),
      limit: config.limits.recentConnection,
      source: 'RECENT_CONNECTION',
    });
  },
};

const interactedCreatorGenerator: CandidateGenerator = {
  source: 'INTERACTED_CREATOR',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    // Strongest affinities first, so the cap keeps the creators that matter.
    const authorIds = Object.entries(viewer.creatorAffinity)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 60)
      .map(([id]) => id);

    return postsByAuthors({
      authorIds,
      excludedAuthorIds,
      visibilities: PUBLIC_VISIBILITIES,
      since: cutoff(nowMs, config.freshness.maxAgeHours),
      limit: config.limits.interactedCreator,
      source: 'INTERACTED_CREATOR',
    });
  },
};

const secondDegreeGenerator: CandidateGenerator = {
  source: 'SECOND_DEGREE',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    return postsByAuthors({
      authorIds: viewer.secondDegreeIds.slice(0, 120),
      excludedAuthorIds,
      visibilities: PUBLIC_VISIBILITIES,
      since: cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336)),
      limit: config.limits.secondDegree,
      source: 'SECOND_DEGREE',
    });
  },
};

// ---------------------------------------------------------------------------
// Similarity pools
// ---------------------------------------------------------------------------

const collegeGenerator: CandidateGenerator = {
  source: 'COLLEGE',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    if (!viewer.college) return [];
    const since = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336));

    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      JOIN "users" u ON u."id" = p."authorId"
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${since}
        AND u."college" = ${viewer.college}
        AND u."isBanned" = false
        AND p."authorId" <> ${viewer.userId}
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.college}
    `);

    return toRefs(rows, 'COLLEGE');
  },
};

const courseGenerator: CandidateGenerator = {
  source: 'COURSE',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    if (!viewer.branch && !viewer.degree) return [];
    const since = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336));

    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      JOIN "users" u ON u."id" = p."authorId"
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${since}
        AND u."isBanned" = false
        AND p."authorId" <> ${viewer.userId}
        AND (
          ${viewer.branch ? Prisma.sql`u."branch" = ${viewer.branch}` : Prisma.sql`false`}
          OR ${viewer.degree ? Prisma.sql`u."degree" = ${viewer.degree}` : Prisma.sql`false`}
        )
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.course}
    `);

    return toRefs(rows, 'COURSE');
  },
};

const interestGenerator: CandidateGenerator = {
  source: 'INTEREST',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    // Interests are stored on the *author*, so overlap finds people who care
    // about the same things. Post-level topical fit is scored later from text.
    const interests = viewer.interestTokens.slice(0, 12);
    if (interests.length === 0) return [];
    const since = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336));

    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      JOIN "users" u ON u."id" = p."authorId"
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${since}
        AND u."isBanned" = false
        AND p."authorId" <> ${viewer.userId}
        AND EXISTS (
          SELECT 1 FROM unnest(u."interests") AS interest
          WHERE lower(interest) IN (${Prisma.join(interests)})
        )
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.interest}
    `);

    return toRefs(rows, 'INTEREST');
  },
};

const skillGenerator: CandidateGenerator = {
  source: 'SKILL',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    const skills = viewer.skillTokens.slice(0, 12);
    if (skills.length === 0) return [];
    const since = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336));

    // Joins through the normalised skill tables rather than scanning post text:
    // skills.name is unique-indexed and user_skills.skillId is indexed.
    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${since}
        AND p."authorId" <> ${viewer.userId}
        AND EXISTS (
          SELECT 1
          FROM "user_skills" us
          JOIN "skills" s ON s."id" = us."skillId"
          WHERE us."userId" = p."authorId" AND lower(s."name") IN (${Prisma.join(skills)})
        )
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.skill}
    `);

    return toRefs(rows, 'SKILL');
  },
};

// ---------------------------------------------------------------------------
// Quality / discovery pools
// ---------------------------------------------------------------------------

const cohortPopularGenerator: CandidateGenerator = {
  source: 'COHORT_POPULAR',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    if (!viewer.college) return [];
    const engagementSince = cutoff(nowMs, 72);
    const postSince = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336));

    // "Performing well among users like me": at least two distinct people from
    // the same college engaged recently. Two, not one, so a single account
    // cannot inject a post into its whole cohort's feed.
    const rows = await prismaRead.$queryRaw<Array<PostRefRow & { sourceScore: number }>>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt",
             COUNT(DISTINCT l."userId")::int AS "sourceScore"
      FROM "post_likes" l
      JOIN "posts" p ON p."id" = l."postId"
      JOIN "users" u ON u."id" = l."userId"
      WHERE l."createdAt" >= ${engagementSince}
        AND u."college" = ${viewer.college}
        AND u."isBanned" = false
        AND l."userId" <> ${viewer.userId}
        AND p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${postSince}
        AND p."authorId" <> ${viewer.userId}
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      GROUP BY p."id", p."authorId", p."createdAt"
      HAVING COUNT(DISTINCT l."userId") >= 2
      ORDER BY COUNT(DISTINCT l."userId") DESC, p."createdAt" DESC
      LIMIT ${config.limits.cohortPopular}
    `);

    return toRefs(rows, 'COHORT_POPULAR');
  },
};

const trendingGenerator: CandidateGenerator = {
  source: 'TRENDING',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    const windowStart = cutoff(nowMs, config.engagement.velocityWindowHours);
    const postSince = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 168));
    const w = config.engagement.weights;

    // Velocity inside a rolling window, never lifetime totals — so nothing
    // trends forever and an old viral post cannot hold a slot.
    const rows = await prismaRead.$queryRaw<Array<PostRefRow & { sourceScore: number }>>(Prisma.sql`
      WITH "recent_likes" AS (
        SELECT "postId", COUNT(DISTINCT "userId")::int AS "actors"
        FROM "post_likes"
        WHERE "createdAt" >= ${windowStart}
        GROUP BY "postId"
      ),
      "recent_comments" AS (
        SELECT "postId", COUNT(DISTINCT "authorId")::int AS "actors"
        FROM "post_comments"
        WHERE "createdAt" >= ${windowStart}
        GROUP BY "postId"
      ),
      "recent_saves" AS (
        SELECT "postId", COUNT(DISTINCT "userId")::int AS "actors"
        FROM "saved_posts"
        WHERE "createdAt" >= ${windowStart}
        GROUP BY "postId"
      )
      SELECT p."id", p."authorId", p."createdAt",
             (COALESCE(rl."actors", 0) * ${w.like}
              + COALESCE(rc."actors", 0) * ${w.comment}
              + COALESCE(rs."actors", 0) * ${w.save})::float AS "sourceScore"
      FROM "posts" p
      LEFT JOIN "recent_likes" rl ON rl."postId" = p."id"
      LEFT JOIN "recent_comments" rc ON rc."postId" = p."id"
      LEFT JOIN "recent_saves" rs ON rs."postId" = p."id"
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${postSince}
        AND p."authorId" <> ${viewer.userId}
        AND (COALESCE(rl."actors", 0) + COALESCE(rc."actors", 0) + COALESCE(rs."actors", 0)) >= 2
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      ORDER BY "sourceScore" DESC, p."createdAt" DESC
      LIMIT ${config.limits.trending}
    `);

    return toRefs(rows, 'TRENDING');
  },
};

const newCreatorGenerator: CandidateGenerator = {
  source: 'NEW_CREATOR',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    const since = cutoff(nowMs, 72);
    const knownAuthorIds = Array.from(
      new Set([viewer.userId, ...viewer.followingIds, ...viewer.connectionIds, ...excludedAuthorIds])
    ).slice(0, 2_000);

    // Cold start for creators: fresh posts that have had almost no distribution
    // yet. Without this, a post with zero engagement can never earn any, and
    // established creators keep every slot permanently.
    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      JOIN "users" u ON u."id" = p."authorId"
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${since}
        AND u."isBanned" = false
        AND u."onboardingCompleted" = true
        AND p."likesCount" + p."commentsCount" + p."sharesCount" <= 3
        ${knownAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(knownAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.newCreator}
    `);

    return toRefs(rows, 'NEW_CREATOR');
  },
};

const discoveryGenerator: CandidateGenerator = {
  source: 'DISCOVERY',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    const since = cutoff(nowMs, 168);
    const knownAuthorIds = Array.from(
      new Set([viewer.userId, ...viewer.followingIds, ...viewer.connectionIds, ...excludedAuthorIds])
    ).slice(0, 2_000);

    // Relevant strangers: active, onboarded authors outside the viewer's graph.
    // Ordered by recency rather than popularity so discovery does not collapse
    // into "the same few big accounts" every session.
    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      JOIN "users" u ON u."id" = p."authorId"
      WHERE p."isActive" = true
        AND p."visibility" IN ('public', 'PUBLIC')
        AND p."createdAt" >= ${since}
        AND u."isBanned" = false
        AND u."onboardingCompleted" = true
        ${knownAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(knownAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.discovery}
    `);

    return toRefs(rows, 'DISCOVERY');
  },
};

/**
 * Recency backfill and the viewer's own posts.
 *
 * Also the guarantee that the candidate set is never empty: a brand-new account
 * with no graph, no college and no interests still gets a feed from here.
 */
const recentGenerator: CandidateGenerator = {
  source: 'RECENT',
  async generate({ viewer, excludedAuthorIds, nowMs, config }) {
    const since = cutoff(nowMs, Math.min(config.freshness.maxAgeHours, 336));

    const rows = await prismaRead.$queryRaw<PostRefRow[]>(Prisma.sql`
      SELECT p."id", p."authorId", p."createdAt"
      FROM "posts" p
      WHERE p."isActive" = true
        AND p."createdAt" >= ${since}
        AND (p."visibility" IN ('public', 'PUBLIC') OR p."authorId" = ${viewer.userId})
        ${excludedAuthorIds.length
          ? Prisma.sql`AND p."authorId" NOT IN (${Prisma.join(excludedAuthorIds)})`
          : Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${config.limits.recent}
    `);

    return toRefs(rows, 'RECENT');
  },
};

export const CANDIDATE_GENERATORS: readonly CandidateGenerator[] = [
  followingGenerator,
  connectionGenerator,
  recentConnectionGenerator,
  interactedCreatorGenerator,
  secondDegreeGenerator,
  collegeGenerator,
  courseGenerator,
  interestGenerator,
  skillGenerator,
  cohortPopularGenerator,
  trendingGenerator,
  newCreatorGenerator,
  discoveryGenerator,
  recentGenerator,
];

/**
 * Merges refs into one candidate per post, keeping every source that produced
 * it. A post reached through three pools is one candidate with three sources —
 * de-duplication happens here, never at ranking time.
 */
export function mergeCandidates(refs: FeedCandidateRef[]): Map<string, import('./feed-types').FeedCandidate> {
  const merged = new Map<string, import('./feed-types').FeedCandidate>();

  for (const ref of refs) {
    if (!ref?.postId || !ref?.authorId) continue;

    const existing = merged.get(ref.postId);
    if (existing) {
      existing.sources.add(ref.source);
      if (ref.sourceScore !== undefined) {
        const previous = existing.sourceScores[ref.source] ?? 0;
        existing.sourceScores[ref.source] = Math.max(previous, ref.sourceScore);
      }
      continue;
    }

    merged.set(ref.postId, {
      postId: ref.postId,
      authorId: ref.authorId,
      createdAt: ref.createdAt,
      sources: new Set([ref.source]),
      sourceScores: ref.sourceScore === undefined ? {} : { [ref.source]: ref.sourceScore },
    });
  }

  return merged;
}

export interface GeneratedCandidates {
  candidates: Map<string, import('./feed-types').FeedCandidate>;
  sourceCounts: Record<string, number>;
  failedSources: CandidateSource[];
}

/**
 * Runs every pool concurrently and merges the results.
 *
 * A pool that throws contributes nothing and is reported in `failedSources`;
 * the feed still serves. `RECENT` is the safety net that keeps the merged set
 * non-empty even if every personalised pool fails.
 */
export async function generateCandidates(
  input: Omit<CandidateGeneratorInput, 'config'> & { config?: FeedConfig }
): Promise<GeneratedCandidates> {
  const config = input.config || getFeedConfig();
  const generatorInput: CandidateGeneratorInput = { ...input, config };

  const settled = await Promise.allSettled(
    CANDIDATE_GENERATORS.map((generator) => generator.generate(generatorInput))
  );

  const refs: FeedCandidateRef[] = [];
  const sourceCounts: Record<string, number> = {};
  const failedSources: CandidateSource[] = [];

  settled.forEach((result, index) => {
    const generator = CANDIDATE_GENERATORS[index];
    if (result.status === 'rejected') {
      failedSources.push(generator.source);
      console.error(`[feed-v2] candidate source ${generator.source} failed:`, result.reason);
      return;
    }
    sourceCounts[generator.source] = result.value.length;
    refs.push(...result.value);
  });

  return { candidates: mergeCandidates(refs), sourceCounts, failedSources };
}
