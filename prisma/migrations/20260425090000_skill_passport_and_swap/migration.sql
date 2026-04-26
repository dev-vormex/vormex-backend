CREATE TABLE IF NOT EXISTS "skill_endorsements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "endorsedById" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceId" TEXT,
    "note" TEXT,
    "rating" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_endorsements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "skill_swap_requests" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "message" TEXT,
    "requesterGoal" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'learn',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sessionLengthMinutes" INTEGER NOT NULL DEFAULT 30,
    "scheduledFor" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_swap_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "skill_swap_sessions" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "learnerId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "sessionLengthMinutes" INTEGER NOT NULL DEFAULT 30,
    "scheduledFor" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "learnerRating" INTEGER,
    "mentorRating" INTEGER,
    "learnerNote" TEXT,
    "mentorNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_swap_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "skill_endorsements_userId_skillName_idx"
ON "skill_endorsements"("userId", "skillName");

CREATE INDEX IF NOT EXISTS "skill_endorsements_endorsedById_createdAt_idx"
ON "skill_endorsements"("endorsedById", "createdAt");

CREATE INDEX IF NOT EXISTS "skill_endorsements_source_sourceId_idx"
ON "skill_endorsements"("source", "sourceId");

CREATE INDEX IF NOT EXISTS "skill_swap_requests_requesterId_status_createdAt_idx"
ON "skill_swap_requests"("requesterId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "skill_swap_requests_recipientId_status_createdAt_idx"
ON "skill_swap_requests"("recipientId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "skill_swap_requests_skill_status_idx"
ON "skill_swap_requests"("skill", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "skill_swap_requests_open_pair_skill_key"
ON "skill_swap_requests"("requesterId", "recipientId", lower("skill"))
WHERE "status" = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS "skill_swap_sessions_requestId_key"
ON "skill_swap_sessions"("requestId");

CREATE INDEX IF NOT EXISTS "skill_swap_sessions_mentorId_status_scheduledFor_idx"
ON "skill_swap_sessions"("mentorId", "status", "scheduledFor");

CREATE INDEX IF NOT EXISTS "skill_swap_sessions_learnerId_status_scheduledFor_idx"
ON "skill_swap_sessions"("learnerId", "status", "scheduledFor");

CREATE INDEX IF NOT EXISTS "skill_swap_sessions_skill_status_idx"
ON "skill_swap_sessions"("skill", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_endorsements_userId_fkey'
  ) THEN
    ALTER TABLE "skill_endorsements"
      ADD CONSTRAINT "skill_endorsements_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_endorsements_skillId_fkey'
  ) THEN
    ALTER TABLE "skill_endorsements"
      ADD CONSTRAINT "skill_endorsements_skillId_fkey"
      FOREIGN KEY ("skillId") REFERENCES "skills"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_endorsements_endorsedById_fkey'
  ) THEN
    ALTER TABLE "skill_endorsements"
      ADD CONSTRAINT "skill_endorsements_endorsedById_fkey"
      FOREIGN KEY ("endorsedById") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_swap_requests_requesterId_fkey'
  ) THEN
    ALTER TABLE "skill_swap_requests"
      ADD CONSTRAINT "skill_swap_requests_requesterId_fkey"
      FOREIGN KEY ("requesterId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_swap_requests_recipientId_fkey'
  ) THEN
    ALTER TABLE "skill_swap_requests"
      ADD CONSTRAINT "skill_swap_requests_recipientId_fkey"
      FOREIGN KEY ("recipientId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_swap_sessions_requestId_fkey'
  ) THEN
    ALTER TABLE "skill_swap_sessions"
      ADD CONSTRAINT "skill_swap_sessions_requestId_fkey"
      FOREIGN KEY ("requestId") REFERENCES "skill_swap_requests"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_swap_sessions_mentorId_fkey'
  ) THEN
    ALTER TABLE "skill_swap_sessions"
      ADD CONSTRAINT "skill_swap_sessions_mentorId_fkey"
      FOREIGN KEY ("mentorId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skill_swap_sessions_learnerId_fkey'
  ) THEN
    ALTER TABLE "skill_swap_sessions"
      ADD CONSTRAINT "skill_swap_sessions_learnerId_fkey"
      FOREIGN KEY ("learnerId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
