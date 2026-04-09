-- Remove profileVisibility column from users table
ALTER TABLE "users" DROP COLUMN IF EXISTS "profileVisibility";

-- Drop ProfileVisibility enum type
DROP TYPE IF EXISTS "ProfileVisibility";
