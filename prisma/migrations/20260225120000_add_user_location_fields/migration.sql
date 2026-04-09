-- Add missing User columns (schema had these but DB didn't - e.g. after db pull / schema sync)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currentCountry" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currentState" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLocationUpdate" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currentCoordinates" JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "currentCountryCode" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deviceInfo" JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastKnownIP" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locationAccuracy" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locationPermission" BOOLEAN DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locationSource" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareLocationPublic" BOOLEAN DEFAULT false;
