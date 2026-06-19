-- Trust & Safety Phase 1: identity trust tiers, explicit blocks, evidence snapshots, and safety audit events.

ALTER TABLE "users"
  ADD COLUMN "phoneEncrypted" TEXT,
  ADD COLUMN "phoneHash" TEXT,
  ADD COLUMN "phoneLast4" VARCHAR(8),
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "identityTrustLevel" TEXT NOT NULL DEFAULT 'BASIC',
  ADD COLUMN "bannedReason" TEXT,
  ADD COLUMN "safetyRestrictedUntil" TIMESTAMP(3),
  ADD COLUMN "safetyRestrictionReason" TEXT,
  ADD COLUMN "safetySuspendedUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_phoneHash_key" ON "users"("phoneHash");
CREATE INDEX "users_identityTrustLevel_idx" ON "users"("identityTrustLevel");
CREATE INDEX "users_safetyRestrictedUntil_idx" ON "users"("safetyRestrictedUntil");
CREATE INDEX "users_safetySuspendedUntil_idx" ON "users"("safetySuspendedUntil");

ALTER TABLE "moderation_reports"
  ADD COLUMN "evidenceSnapshot" JSONB,
  ADD COLUMN "reporterPriorReports" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reportedUserPriorReports" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "blockedUserAfterReport" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "identity_verifications" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "valueHash" TEXT,
  "valueMasked" TEXT,
  "evidenceStorageKey" TEXT,
  "evidenceFileName" TEXT,
  "evidenceMimeType" TEXT,
  "evidenceSize" INTEGER,
  "evidenceDeletedAt" TIMESTAMP(3),
  "reviewNotes" TEXT,
  "rejectionReason" TEXT,
  "metadata" JSONB,
  "reviewedById" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "identity_verifications_userId_status_idx" ON "identity_verifications"("userId", "status");
CREATE INDEX "identity_verifications_type_status_idx" ON "identity_verifications"("type", "status");
CREATE INDEX "identity_verifications_reviewedById_idx" ON "identity_verifications"("reviewedById");
CREATE INDEX "identity_verifications_createdAt_idx" ON "identity_verifications"("createdAt");

ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_verifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_verifications_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "user_blocks" (
  "id" TEXT NOT NULL,
  "blockerId" TEXT NOT NULL,
  "blockedId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_blocks_blockerId_blockedId_key" ON "user_blocks"("blockerId", "blockedId");
CREATE INDEX "user_blocks_blockedId_idx" ON "user_blocks"("blockedId");
CREATE INDEX "user_blocks_blockerId_createdAt_idx" ON "user_blocks"("blockerId", "createdAt");

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blockerId_fkey"
  FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blockedId_fkey"
  FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "safety_events" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "targetUserId" TEXT,
  "eventType" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "safety_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "safety_events_actorId_createdAt_idx" ON "safety_events"("actorId", "createdAt");
CREATE INDEX "safety_events_targetUserId_createdAt_idx" ON "safety_events"("targetUserId", "createdAt");
CREATE INDEX "safety_events_eventType_createdAt_idx" ON "safety_events"("eventType", "createdAt");
CREATE INDEX "safety_events_entityType_entityId_idx" ON "safety_events"("entityType", "entityId");

ALTER TABLE "safety_events"
  ADD CONSTRAINT "safety_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "safety_events"
  ADD CONSTRAINT "safety_events_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
