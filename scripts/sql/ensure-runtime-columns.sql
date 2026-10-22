-- Additive runtime prerequisites from 20260825120000_security_boundary_hardening.
-- Keep existing account balances and verification decisions unchanged.
BEGIN;
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "adminTwoFactorPendingSecret" TEXT,
  ADD COLUMN IF NOT EXISTS "adminTwoFactorPendingAt" TIMESTAMP(3);
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "hiddenForUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "hiddenForUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX IF NOT EXISTS "conversations_hiddenForUserIds_idx"
  ON "conversations" USING GIN ("hiddenForUserIds");
CREATE INDEX IF NOT EXISTS "messages_hiddenForUserIds_idx"
  ON "messages" USING GIN ("hiddenForUserIds");
COMMIT;
