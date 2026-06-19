CREATE TABLE IF NOT EXISTS "profile_boosts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'premium',
  "status" TEXT NOT NULL DEFAULT 'active',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profile_boosts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "profile_boosts_userId_status_endsAt_idx"
ON "profile_boosts"("userId", "status", "endsAt");

CREATE INDEX IF NOT EXISTS "profile_boosts_status_endsAt_priority_idx"
ON "profile_boosts"("status", "endsAt", "priority");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profile_boosts_userId_fkey'
  ) THEN
    ALTER TABLE "profile_boosts"
    ADD CONSTRAINT "profile_boosts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
