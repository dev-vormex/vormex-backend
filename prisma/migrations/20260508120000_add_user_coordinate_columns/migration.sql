-- Prerequisites for the nearby-people indexes in the following migration.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "locationUpdatedAt" TIMESTAMP(3);
