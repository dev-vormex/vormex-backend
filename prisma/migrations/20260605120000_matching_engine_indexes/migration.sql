CREATE INDEX IF NOT EXISTS "users_interests_gin_idx"
ON "users" USING GIN ("interests");

CREATE INDEX IF NOT EXISTS "user_onboarding_secondaryGoals_gin_idx"
ON "user_onboarding" USING GIN ("secondaryGoals");

CREATE INDEX IF NOT EXISTS "user_onboarding_wantToLearn_gin_idx"
ON "user_onboarding" USING GIN ("wantToLearn");

CREATE INDEX IF NOT EXISTS "user_onboarding_canTeach_gin_idx"
ON "user_onboarding" USING GIN ("canTeach");

CREATE INDEX IF NOT EXISTS "user_onboarding_lookingFor_gin_idx"
ON "user_onboarding" USING GIN ("lookingFor");

CREATE INDEX IF NOT EXISTS "user_goals_goal_lower_idx"
ON "user_goals" (LOWER("goal"));

CREATE INDEX IF NOT EXISTS "user_goals_userId_goal_idx"
ON "user_goals" ("userId", "goal");
