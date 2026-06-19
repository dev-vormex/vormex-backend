CREATE TABLE "saved_profiles" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "saved_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_profiles_userId_targetUserId_key"
  ON "saved_profiles"("userId", "targetUserId");

CREATE INDEX "saved_profiles_userId_createdAt_idx"
  ON "saved_profiles"("userId", "createdAt");

CREATE INDEX "saved_profiles_targetUserId_createdAt_idx"
  ON "saved_profiles"("targetUserId", "createdAt");

ALTER TABLE "saved_profiles"
  ADD CONSTRAINT "saved_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_profiles"
  ADD CONSTRAINT "saved_profiles_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
