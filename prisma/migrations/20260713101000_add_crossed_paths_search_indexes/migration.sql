-- This migration must be executed outside a transaction in production.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_interests_gin_idx" ON "users" USING GIN ("interests");
