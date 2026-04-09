DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'emailHash'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "emailHash" TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "contact_syncs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "inviteCount" INTEGER NOT NULL DEFAULT 0,
  "totalCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contact_syncs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "contact_sync_entries" (
  "id" TEXT NOT NULL,
  "syncId" TEXT NOT NULL,
  "contactName" TEXT,
  "emailHash" TEXT NOT NULL,
  "matchStatus" TEXT NOT NULL,
  "matchedUserId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'picker',
  "invitedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contact_sync_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_emailHash_key"
ON "users"("emailHash");

CREATE UNIQUE INDEX IF NOT EXISTS "contact_syncs_userId_key"
ON "contact_syncs"("userId");

CREATE INDEX IF NOT EXISTS "contact_syncs_lastSyncedAt_idx"
ON "contact_syncs"("lastSyncedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "contact_sync_entries_syncId_emailHash_key"
ON "contact_sync_entries"("syncId", "emailHash");

CREATE INDEX IF NOT EXISTS "contact_sync_entries_syncId_matchStatus_idx"
ON "contact_sync_entries"("syncId", "matchStatus");

CREATE INDEX IF NOT EXISTS "contact_sync_entries_emailHash_idx"
ON "contact_sync_entries"("emailHash");

CREATE INDEX IF NOT EXISTS "contact_sync_entries_matchedUserId_idx"
ON "contact_sync_entries"("matchedUserId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_syncs_userId_fkey'
  ) THEN
    ALTER TABLE "contact_syncs"
      ADD CONSTRAINT "contact_syncs_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_sync_entries_syncId_fkey'
  ) THEN
    ALTER TABLE "contact_sync_entries"
      ADD CONSTRAINT "contact_sync_entries_syncId_fkey"
      FOREIGN KEY ("syncId") REFERENCES "contact_syncs"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_sync_entries_matchedUserId_fkey'
  ) THEN
    ALTER TABLE "contact_sync_entries"
      ADD CONSTRAINT "contact_sync_entries_matchedUserId_fkey"
      FOREIGN KEY ("matchedUserId") REFERENCES "users"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
