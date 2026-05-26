-- WhatsApp-style group invite links and direct invitations.

ALTER TABLE "groups"
ADD COLUMN IF NOT EXISTS "inviteCode" TEXT,
ADD COLUMN IF NOT EXISTS "inviteLinkVisibility" TEXT NOT NULL DEFAULT 'ADMINS',
ADD COLUMN IF NOT EXISTS "inviteLinkUpdatedAt" TIMESTAMP(3);

UPDATE "groups"
SET "inviteCode" = 'grp_' || SUBSTRING(MD5("id" || ':' || "creatorId"), 1, 22)
WHERE "inviteCode" IS NULL OR BTRIM("inviteCode") = '';

UPDATE "groups"
SET "inviteLinkUpdatedAt" = COALESCE("inviteLinkUpdatedAt", "updatedAt", NOW())
WHERE "inviteLinkUpdatedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "groups_inviteCode_key" ON "groups"("inviteCode");
CREATE INDEX IF NOT EXISTS "groups_inviteLinkVisibility_idx" ON "groups"("inviteLinkVisibility");

CREATE TABLE IF NOT EXISTS "group_invites" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "invitedUserId" TEXT NOT NULL,
  "invitedById" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "message" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "respondedAt" TIMESTAMP(3),
  CONSTRAINT "group_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_invites_groupId_invitedUserId_key" ON "group_invites"("groupId", "invitedUserId");
CREATE INDEX IF NOT EXISTS "group_invites_groupId_status_idx" ON "group_invites"("groupId", "status");
CREATE INDEX IF NOT EXISTS "group_invites_invitedUserId_status_idx" ON "group_invites"("invitedUserId", "status");
CREATE INDEX IF NOT EXISTS "group_invites_invitedById_idx" ON "group_invites"("invitedById");
CREATE INDEX IF NOT EXISTS "group_invites_expiresAt_idx" ON "group_invites"("expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_invites_groupId_fkey'
  ) THEN
    ALTER TABLE "group_invites"
    ADD CONSTRAINT "group_invites_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_invites_invitedUserId_fkey'
  ) THEN
    ALTER TABLE "group_invites"
    ADD CONSTRAINT "group_invites_invitedUserId_fkey"
    FOREIGN KEY ("invitedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_invites_invitedById_fkey'
  ) THEN
    ALTER TABLE "group_invites"
    ADD CONSTRAINT "group_invites_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "group_join_requests" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "inviteCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedById" TEXT,
  "respondedAt" TIMESTAMP(3),
  CONSTRAINT "group_join_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "group_join_requests_groupId_requesterId_key" ON "group_join_requests"("groupId", "requesterId");
CREATE INDEX IF NOT EXISTS "group_join_requests_groupId_status_idx" ON "group_join_requests"("groupId", "status");
CREATE INDEX IF NOT EXISTS "group_join_requests_requesterId_status_idx" ON "group_join_requests"("requesterId", "status");
CREATE INDEX IF NOT EXISTS "group_join_requests_reviewedById_idx" ON "group_join_requests"("reviewedById");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_join_requests_groupId_fkey'
  ) THEN
    ALTER TABLE "group_join_requests"
    ADD CONSTRAINT "group_join_requests_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_join_requests_requesterId_fkey'
  ) THEN
    ALTER TABLE "group_join_requests"
    ADD CONSTRAINT "group_join_requests_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_join_requests_reviewedById_fkey'
  ) THEN
    ALTER TABLE "group_join_requests"
    ADD CONSTRAINT "group_join_requests_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
