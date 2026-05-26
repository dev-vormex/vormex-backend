CREATE INDEX IF NOT EXISTS "stories_expiresAt_createdAt_id_idx"
ON "stories"("expiresAt", "createdAt", "id");
