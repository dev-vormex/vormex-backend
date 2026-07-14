-- Trigram indexes so insensitive contains/startsWith user searches use index scans
-- instead of sequential scans over users.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "users_username_trgm_idx" ON "users" USING GIN ("username" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_name_trgm_idx" ON "users" USING GIN ("name" gin_trgm_ops);
