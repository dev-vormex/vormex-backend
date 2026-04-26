ALTER TABLE "xp_transactions"
  ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'XP',
  ADD COLUMN IF NOT EXISTS "countsForStreak" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "xp_transactions_idempotencyKey_key"
  ON "xp_transactions"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "xp_transactions_currency_idx"
  ON "xp_transactions"("currency");

UPDATE "User"
SET "coinsBalance" = "xpBalance"
WHERE "coinsBalance" = 0
  AND "xpBalance" > 0;
