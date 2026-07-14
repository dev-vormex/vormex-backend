-- Messages previously had no explicit edit marker; clients inferred "edited" from
-- updatedAt drift, which is also bumped by delivery/read status updates.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);
