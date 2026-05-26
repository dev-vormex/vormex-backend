CREATE INDEX IF NOT EXISTS "users_lastActiveAt_id_idx" ON "users"("lastActiveAt", "id");
CREATE INDEX IF NOT EXISTS "users_college_lastActiveAt_idx" ON "users"("college", "lastActiveAt");
CREATE INDEX IF NOT EXISTS "users_branch_lastActiveAt_idx" ON "users"("branch", "lastActiveAt");
CREATE INDEX IF NOT EXISTS "users_graduationYear_lastActiveAt_idx" ON "users"("graduationYear", "lastActiveAt");
CREATE INDEX IF NOT EXISTS "users_isOpenToOpportunities_lastActiveAt_idx" ON "users"("isOpenToOpportunities", "lastActiveAt");

CREATE INDEX IF NOT EXISTS "reels_status_visibility_publishedAt_viewsCount_id_idx" ON "reels"("status", "visibility", "publishedAt", "viewsCount", "id");
CREATE INDEX IF NOT EXISTS "reels_authorId_status_visibility_publishedAt_idx" ON "reels"("authorId", "status", "visibility", "publishedAt");
