BEGIN;

-- MFA rotation keeps the active factor valid until a short-lived candidate is proven.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "adminTwoFactorPendingSecret" TEXT,
  ADD COLUMN IF NOT EXISTS "adminTwoFactorPendingAt" TIMESTAMP(3);

-- Per-user chat tombstones preserve the other participant's copy.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "hiddenForUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "hiddenForUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX IF NOT EXISTS "conversations_hiddenForUserIds_idx"
  ON "conversations" USING GIN ("hiddenForUserIds");
CREATE INDEX IF NOT EXISTS "messages_hiddenForUserIds_idx"
  ON "messages" USING GIN ("hiddenForUserIds");

-- Profile text and creator status are not institution verification evidence.
ALTER TABLE "college_communities"
  ALTER COLUMN "verificationMode" SET DEFAULT 'student_email_otp';
ALTER TABLE "college_student_verifications"
  ALTER COLUMN "status" SET DEFAULT 'pending',
  ALTER COLUMN "method" SET DEFAULT 'manual_review';
UPDATE "college_student_verifications"
SET "status" = 'pending', "method" = 'manual_review', "verifiedAt" = NULL
WHERE "status" = 'verified'
  AND "method" NOT IN ('student_email_otp', 'manual_review');

-- Defense in depth for atomic coin spending.
UPDATE "users" SET "coinsBalance" = 0 WHERE "coinsBalance" < 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_coinsBalance_nonnegative'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "User_coinsBalance_nonnegative" CHECK ("coinsBalance" >= 0);
  END IF;
END $$;
COMMIT;
