DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'user_feature_access_overrides'
  ) THEN
    ALTER TABLE "user_feature_access_overrides"
      ADD COLUMN IF NOT EXISTS "agentBlocked" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "profileCustomizationBlocked" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "user_feature_access_overrides_agentBlocked_idx"
ON "user_feature_access_overrides"("agentBlocked");

CREATE INDEX IF NOT EXISTS "user_feature_access_overrides_profileCustomizationBlocked_idx"
ON "user_feature_access_overrides"("profileCustomizationBlocked");
