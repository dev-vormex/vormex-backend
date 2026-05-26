CREATE INDEX IF NOT EXISTS "reel_comments_reelId_parentId_isPinned_likesCount_createdAt_id_idx"
ON "reel_comments"("reelId", "parentId", "isPinned", "likesCount", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "reel_saves_reelId_idx"
ON "reel_saves"("reelId");

CREATE INDEX IF NOT EXISTS "reel_saves_userId_createdAt_id_idx"
ON "reel_saves"("userId", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "saved_posts_userId_createdAt_id_idx"
ON "saved_posts"("userId", "createdAt", "id");
