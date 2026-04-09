ALTER TABLE "posts"
ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE TABLE IF NOT EXISTS "post_poll_votes" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "post_poll_votes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "post_poll_votes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "post_poll_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "post_poll_votes_postId_userId_key"
ON "post_poll_votes"("postId", "userId");

CREATE INDEX IF NOT EXISTS "post_poll_votes_postId_idx"
ON "post_poll_votes"("postId");

CREATE INDEX IF NOT EXISTS "post_poll_votes_userId_idx"
ON "post_poll_votes"("userId");
