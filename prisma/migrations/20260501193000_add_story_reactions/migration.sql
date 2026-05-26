CREATE TABLE "story_reactions" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reactionType" TEXT NOT NULL DEFAULT 'LIKE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_reactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "story_reactions_storyId_userId_key" ON "story_reactions"("storyId", "userId");
CREATE INDEX "story_reactions_storyId_idx" ON "story_reactions"("storyId");
CREATE INDEX "story_reactions_userId_idx" ON "story_reactions"("userId");
CREATE INDEX "story_reactions_createdAt_idx" ON "story_reactions"("createdAt");

ALTER TABLE "story_reactions"
ADD CONSTRAINT "story_reactions_storyId_fkey"
FOREIGN KEY ("storyId") REFERENCES "stories"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "story_reactions"
ADD CONSTRAINT "story_reactions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
