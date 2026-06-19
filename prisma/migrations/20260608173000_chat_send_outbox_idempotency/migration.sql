ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_idempotencyKey_key"
ON "outbox_events"("idempotencyKey")
WHERE "idempotencyKey" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "messages_senderId_clientMessageId_key"
ON "messages"("senderId", "clientMessageId")
WHERE "clientMessageId" IS NOT NULL;
