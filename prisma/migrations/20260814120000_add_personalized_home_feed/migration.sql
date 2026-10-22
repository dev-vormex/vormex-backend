-- Personalized home feed (feed-v2).
--
-- Additive only: no column is dropped or retyped, and every statement is
-- idempotent so a partially applied migration can be replayed safely.

-- ---------------------------------------------------------------------------
-- 1. Impression ledger gains the columns the ranker needs to learn from.
--
-- `feed_impressions` previously stored only (userId, postId, seenAt), which is
-- enough to demote a seen post but not enough to answer "does this viewer keep
-- skipping this creator?" or to reconstruct which ranking produced a session.
-- ---------------------------------------------------------------------------
ALTER TABLE "feed_impressions"
  ADD COLUMN IF NOT EXISTS "creatorId"       TEXT,
  ADD COLUMN IF NOT EXISTS "feedSessionId"   TEXT,
  ADD COLUMN IF NOT EXISTS "position"        INTEGER,
  ADD COLUMN IF NOT EXISTS "candidateSource" TEXT,
  ADD COLUMN IF NOT EXISTS "rankingScore"    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "rankingVersion"  TEXT,
  ADD COLUMN IF NOT EXISTS "seenCount"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "firstSeenAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dwellMs"         INTEGER;

-- Per-creator skip/dwell aggregation for a single viewer.
CREATE INDEX IF NOT EXISTS "feed_impressions_userId_creatorId_seenAt_idx"
  ON "feed_impressions" ("userId", "creatorId", "seenAt");

-- Offline joins from a ranked session back to what was actually seen.
CREATE INDEX IF NOT EXISTS "feed_impressions_feedSessionId_idx"
  ON "feed_impressions" ("feedSessionId");

-- ---------------------------------------------------------------------------
-- 2. Candidate-generation indexes.
--
-- feed-v2 replaces the single "newest N posts globally" scan with per-pool
-- lookups. Each pool is either author-scoped (already covered by
-- posts(authorId, isActive, createdAt)) or a public-recency scan, which is what
-- the index below serves.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "posts_isActive_visibility_createdAt_idx"
  ON "posts" ("isActive", "visibility", "createdAt" DESC);

-- ---------------------------------------------------------------------------
-- 3. Engagement-velocity and viewer-affinity indexes.
--
-- Trending is computed from engagement inside a rolling window rather than from
-- lifetime counters, and creator affinity is derived from the viewer's own
-- recent likes/comments. Both need a createdAt-ordered access path.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "post_likes_postId_createdAt_idx"
  ON "post_likes" ("postId", "createdAt");

CREATE INDEX IF NOT EXISTS "post_likes_userId_createdAt_idx"
  ON "post_likes" ("userId", "createdAt");

-- Rolling trending window scans by time alone, so it needs a leading createdAt.
CREATE INDEX IF NOT EXISTS "post_likes_createdAt_idx"
  ON "post_likes" ("createdAt");

CREATE INDEX IF NOT EXISTS "post_comments_postId_createdAt_author_idx"
  ON "post_comments" ("postId", "createdAt", "authorId");

CREATE INDEX IF NOT EXISTS "post_comments_authorId_createdAt_idx"
  ON "post_comments" ("authorId", "createdAt");

CREATE INDEX IF NOT EXISTS "post_comments_createdAt_idx"
  ON "post_comments" ("createdAt");

CREATE INDEX IF NOT EXISTS "saved_posts_postId_createdAt_idx"
  ON "saved_posts" ("postId", "createdAt");

-- Interest pool matches viewers to authors by array overlap (users.interests &&).
CREATE INDEX IF NOT EXISTS "users_interests_gin_idx"
  ON "users" USING GIN ("interests");

-- Eligibility hides posts the viewer themselves reported. Partial index keeps it
-- tiny: only rows that actually name a post are ever looked up this way.
CREATE INDEX IF NOT EXISTS "moderation_reports_reporterId_reportedPostId_idx"
  ON "moderation_reports" ("reporterId", "reportedPostId")
  WHERE "reportedPostId" IS NOT NULL;

-- Recent-connection pool: connections accepted inside the last N days.
CREATE INDEX IF NOT EXISTS "connections_status_updatedAt_idx"
  ON "connections" ("status", "updatedAt" DESC);

-- Follow pools are read in both directions (following, and mutual-follow checks).
CREATE INDEX IF NOT EXISTS "follows_followerId_createdAt_idx"
  ON "follows" ("followerId", "createdAt" DESC);
