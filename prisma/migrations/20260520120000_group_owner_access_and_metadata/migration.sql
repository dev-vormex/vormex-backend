ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "rules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "group_members" AS member
SET "role" = 'owner'
FROM "groups" AS group_record
WHERE member."groupId" = group_record."id"
  AND member."userId" = group_record."creatorId"
  AND LOWER(member."role") <> 'owner';

INSERT INTO "group_members" ("id", "groupId", "userId", "role", "joinedAt")
SELECT
  'owner-' || MD5(group_record."id" || ':' || group_record."creatorId"),
  group_record."id",
  group_record."creatorId",
  'owner',
  group_record."createdAt"
FROM "groups" AS group_record
WHERE NOT EXISTS (
  SELECT 1
  FROM "group_members" AS member
  WHERE member."groupId" = group_record."id"
    AND member."userId" = group_record."creatorId"
);

UPDATE "groups" AS group_record
SET "memberCount" = member_counts.member_count
FROM (
  SELECT "groupId", COUNT(*)::INT AS member_count
  FROM "group_members"
  GROUP BY "groupId"
) AS member_counts
WHERE group_record."id" = member_counts."groupId";

UPDATE "groups" AS group_record
SET "memberCount" = 0
WHERE NOT EXISTS (
  SELECT 1
  FROM "group_members" AS member
  WHERE member."groupId" = group_record."id"
);
