-- Support public/private filtering followed by stable popularity ordering.
CREATE INDEX IF NOT EXISTS "groups_visibility_members_idx"
ON "groups"("isPrivate", "memberCount" DESC, "id");
