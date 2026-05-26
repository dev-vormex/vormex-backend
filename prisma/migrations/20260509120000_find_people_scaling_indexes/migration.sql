CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX IF NOT EXISTS "users_isBanned_lastActiveAt_id_idx"
ON "users"("isBanned", "lastActiveAt", "id");

CREATE INDEX IF NOT EXISTS "users_shareLocationPublic_latitude_longitude_idx"
ON "users"("shareLocationPublic", "latitude", "longitude");

CREATE INDEX IF NOT EXISTS "users_shareLocationPublic_locationPermission_latitude_longitude_idx"
ON "users"("shareLocationPublic", "locationPermission", "latitude", "longitude");

CREATE INDEX IF NOT EXISTS "users_currentCity_lastActiveAt_idx"
ON "users"("currentCity", "lastActiveAt");

CREATE INDEX IF NOT EXISTS "connections_requester_status_addressee_idx"
ON "connections"("requesterId", "status", "addresseeId");

CREATE INDEX IF NOT EXISTS "connections_addressee_status_requester_idx"
ON "connections"("addresseeId", "status", "requesterId");

CREATE INDEX IF NOT EXISTS "user_onboarding_primaryGoal_idx"
ON "user_onboarding"("primaryGoal");

CREATE INDEX IF NOT EXISTS "users_name_trgm_idx"
ON "users" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_username_trgm_idx"
ON "users" USING GIN ("username" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_headline_trgm_idx"
ON "users" USING GIN ("headline" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_bio_trgm_idx"
ON "users" USING GIN ("bio" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_college_trgm_idx"
ON "users" USING GIN ("college" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_branch_trgm_idx"
ON "users" USING GIN ("branch" gin_trgm_ops);
