DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contact_sync_entries'
      AND column_name = 'joinedNotificationQueuedAt'
  ) THEN
    ALTER TABLE "contact_sync_entries" ADD COLUMN "joinedNotificationQueuedAt" TIMESTAMP(3);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'contact_sync_entries'
      AND column_name = 'joinedNotificationSentAt'
  ) THEN
    ALTER TABLE "contact_sync_entries" ADD COLUMN "joinedNotificationSentAt" TIMESTAMP(3);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "contact_join_notification_windows" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastNotifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "contact_join_notification_windows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_join_notification_windows_userId_key"
ON "contact_join_notification_windows"("userId");

CREATE INDEX IF NOT EXISTS "contact_join_notification_windows_lastNotifiedAt_idx"
ON "contact_join_notification_windows"("lastNotifiedAt");

CREATE INDEX IF NOT EXISTS "contact_sync_entries_joinedNotificationQueuedAt_joinedNotificationSentAt_idx"
ON "contact_sync_entries"("joinedNotificationQueuedAt", "joinedNotificationSentAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_join_notification_windows_userId_fkey'
  ) THEN
    ALTER TABLE "contact_join_notification_windows"
      ADD CONSTRAINT "contact_join_notification_windows_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;
