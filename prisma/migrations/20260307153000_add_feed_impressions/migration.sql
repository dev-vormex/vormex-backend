-- Create feed impressions table for feed seen-post tracking (idempotent).
CREATE TABLE IF NOT EXISTS "feed_impressions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feed_impressions_pkey" PRIMARY KEY ("id")
);

-- Composite uniqueness: one row per user/post pair.
CREATE UNIQUE INDEX IF NOT EXISTS "feed_impressions_userId_postId_key"
ON "feed_impressions"("userId", "postId");

-- Query/index support for feed rank lookup + cleanup.
CREATE INDEX IF NOT EXISTS "feed_impressions_userId_seenAt_idx"
ON "feed_impressions"("userId", "seenAt");

CREATE INDEX IF NOT EXISTS "feed_impressions_seenAt_idx"
ON "feed_impressions"("seenAt");
