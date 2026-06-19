ALTER TABLE "group_members"
ADD COLUMN "showInMessages" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "messagesAddedAt" TIMESTAMP(3);

CREATE INDEX "group_members_userId_showInMessages_idx" ON "group_members"("userId", "showInMessages");
