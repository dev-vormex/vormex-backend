-- Existing onboarding-field migrations did not create this model's table.
CREATE TABLE IF NOT EXISTS "user_onboarding" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "isCompleted" BOOLEAN NOT NULL DEFAULT false,
  "completedAt" TIMESTAMP(3),
  "currentStep" INTEGER NOT NULL DEFAULT 0,
  "primaryGoal" TEXT,
  "secondaryGoals" TEXT[],
  "wantToLearn" TEXT[],
  "canTeach" TEXT[],
  "lookingFor" TEXT[],
  "availability" TEXT,
  "hoursPerWeek" INTEGER,
  "communicationPref" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_onboarding_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_onboarding_userId_key" ON "user_onboarding"("userId");
CREATE INDEX IF NOT EXISTS "user_onboarding_userId_idx" ON "user_onboarding"("userId");
CREATE INDEX IF NOT EXISTS "user_onboarding_isCompleted_idx" ON "user_onboarding"("isCompleted");
