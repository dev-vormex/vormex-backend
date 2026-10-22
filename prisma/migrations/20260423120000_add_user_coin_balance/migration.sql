-- The progress backfill needs the coin balance before copying existing XP.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "coinsBalance" INTEGER NOT NULL DEFAULT 0;
