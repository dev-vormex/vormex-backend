CREATE INDEX IF NOT EXISTS "posts_isActive_createdAt_id_idx"
  ON "posts" ("isActive", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "conversations_participant1Id_lastMessageAt_id_idx"
  ON "conversations" ("participant1Id", "lastMessageAt", "id");

CREATE INDEX IF NOT EXISTS "conversations_participant2Id_lastMessageAt_id_idx"
  ON "conversations" ("participant2Id", "lastMessageAt", "id");

CREATE INDEX IF NOT EXISTS "messages_conversationId_createdAt_id_idx"
  ON "messages" ("conversationId", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "notifications_userId_createdAt_id_idx"
  ON "notifications" ("userId", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_createdAt_id_idx"
  ON "notifications" ("userId", "isRead", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "reels_status_visibility_publishedAt_id_idx"
  ON "reels" ("status", "visibility", "publishedAt", "id");

CREATE INDEX IF NOT EXISTS "reels_authorId_status_visibility_createdAt_id_idx"
  ON "reels" ("authorId", "status", "visibility", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "reels_status_visibility_audioId_createdAt_id_idx"
  ON "reels" ("status", "visibility", "audioId", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "reels_originalReelId_status_visibility_createdAt_id_idx"
  ON "reels" ("originalReelId", "status", "visibility", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "reels_authorId_status_updatedAt_id_idx"
  ON "reels" ("authorId", "status", "updatedAt", "id");

CREATE INDEX IF NOT EXISTS "reel_saves_userId_createdAt_id_idx"
  ON "reel_saves" ("userId", "createdAt", "id");
