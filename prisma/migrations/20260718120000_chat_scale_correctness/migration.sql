DROP INDEX IF EXISTS "messages_conversationId_senderId_clientMessageId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "messages_senderId_clientMessageId_key"
  ON "messages" ("senderId", "clientMessageId")
  WHERE "clientMessageId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_idempotencyKey_key"
  ON "outbox_events" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "messages_conversationId_receiverId_status_idx"
  ON "messages" ("conversationId", "receiverId", "status");

DROP INDEX IF EXISTS "conversations_participant1Id_lastMessageAt_id_idx";
DROP INDEX IF EXISTS "conversations_participant2Id_lastMessageAt_id_idx";

CREATE INDEX "conversations_participant1Id_lastMessageAt_id_idx"
  ON "conversations" ("participant1Id", "lastMessageAt" DESC NULLS LAST, "id" ASC);

CREATE INDEX "conversations_participant2Id_lastMessageAt_id_idx"
  ON "conversations" ("participant2Id", "lastMessageAt" DESC NULLS LAST, "id" ASC);
