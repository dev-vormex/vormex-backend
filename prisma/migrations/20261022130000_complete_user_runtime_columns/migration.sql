-- Add model fields absent from the historical migration chain without
-- dropping legacy onboarding data or changing existing balances.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "hasClaimedWelcomeGift" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "profileRing" TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "onboardingCompleteness" INTEGER NOT NULL DEFAULT 0;
