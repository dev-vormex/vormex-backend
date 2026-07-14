CREATE TABLE "proximity_preferences" (
  "userId" TEXT NOT NULL,
  "crossedPathsDiscoverable" BOOLEAN NOT NULL DEFAULT FALSE,
  "publicForegroundPresenceEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "summaryNotificationsEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "consentVersion" TEXT,
  "consentedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "proximity_preferences_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "proximity_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "proximity_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authSessionId" TEXT,
  "deviceInstallHash" TEXT,
  "clientStartId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'active',
  "radiusM" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "endReason" TEXT,
  "summaryStatus" TEXT NOT NULL DEFAULT 'pending',
  "summaryCount" INTEGER,
  "summaryReadyAt" TIMESTAMP(3),
  "summaryNotifiedAt" TIMESTAMP(3),
  "summaryViewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "proximity_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proximity_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "proximity_sessions_radius_check" CHECK ("radiusM" IN (200, 300, 500)),
  CONSTRAINT "proximity_sessions_generation_check" CHECK ("generation" >= 1),
  CONSTRAINT "proximity_sessions_status_check" CHECK ("status" IN ('active','stopped','expired','interrupted','invalidated')),
  CONSTRAINT "proximity_sessions_expiry_check" CHECK ("expiresAt" <= "startedAt" + INTERVAL '8 hours')
);
CREATE UNIQUE INDEX "proximity_sessions_userId_clientStartId_key" ON "proximity_sessions"("userId", "clientStartId");
CREATE UNIQUE INDEX "proximity_sessions_one_active_user_idx" ON "proximity_sessions"("userId") WHERE "status" = 'active';
CREATE INDEX "proximity_sessions_status_expiresAt_idx" ON "proximity_sessions"("status", "expiresAt");
CREATE INDEX "proximity_sessions_userId_status_updatedAt_idx" ON "proximity_sessions"("userId", "status", "updatedAt");

CREATE TABLE "proximity_encounter_pairs" (
  "id" TEXT NOT NULL,
  "lowerUserId" TEXT NOT NULL,
  "higherUserId" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "accumulatedDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "sampleCount" INTEGER NOT NULL DEFAULT 0,
  "minimumObservedDistanceM" DOUBLE PRECISION NOT NULL,
  "encounterCount" INTEGER NOT NULL DEFAULT 1,
  "areaLabel" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "proximity_encounter_pairs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proximity_encounter_pairs_lowerUserId_fkey" FOREIGN KEY ("lowerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "proximity_encounter_pairs_higherUserId_fkey" FOREIGN KEY ("higherUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "proximity_encounter_pair_order_check" CHECK ("lowerUserId" < "higherUserId"),
  CONSTRAINT "proximity_encounter_pair_values_check" CHECK ("accumulatedDurationSeconds" >= 0 AND "sampleCount" >= 0 AND "minimumObservedDistanceM" >= 0 AND "encounterCount" >= 1),
  CONSTRAINT "proximity_encounter_pair_time_check" CHECK ("firstSeenAt" <= "lastSeenAt"),
  CONSTRAINT "proximity_encounter_pair_expiry_check" CHECK ("expiresAt" = "lastSeenAt" + INTERVAL '7 days')
);
CREATE UNIQUE INDEX "proximity_encounter_pairs_lowerUserId_higherUserId_key" ON "proximity_encounter_pairs"("lowerUserId", "higherUserId");
CREATE INDEX "proximity_encounter_pairs_expiresAt_idx" ON "proximity_encounter_pairs"("expiresAt");
CREATE INDEX "proximity_encounter_pairs_lastSeenAt_id_idx" ON "proximity_encounter_pairs"("lastSeenAt" DESC, "id" DESC);
CREATE INDEX "proximity_encounter_pairs_lower_last_idx" ON "proximity_encounter_pairs"("lowerUserId", "lastSeenAt" DESC, "id" DESC);
CREATE INDEX "proximity_encounter_pairs_higher_last_idx" ON "proximity_encounter_pairs"("higherUserId", "lastSeenAt" DESC, "id" DESC);
CREATE INDEX "proximity_encounter_pairs_lower_duration_idx" ON "proximity_encounter_pairs"("lowerUserId", "accumulatedDurationSeconds" DESC, "lastSeenAt" DESC, "id" DESC);
CREATE INDEX "proximity_encounter_pairs_higher_duration_idx" ON "proximity_encounter_pairs"("higherUserId", "accumulatedDurationSeconds" DESC, "lastSeenAt" DESC, "id" DESC);

CREATE TABLE "proximity_encounter_user_state" (
  "encounterId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "hiddenAt" TIMESTAMP(3),
  "removedAt" TIMESTAMP(3),
  "savedAt" TIMESTAMP(3),
  "lastViewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "proximity_encounter_user_state_pkey" PRIMARY KEY ("encounterId", "ownerUserId"),
  CONSTRAINT "proximity_encounter_user_state_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "proximity_encounter_pairs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "proximity_encounter_user_state_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "proximity_encounter_user_state_owner_hidden_removed_idx" ON "proximity_encounter_user_state"("ownerUserId", "hiddenAt", "removedAt");
CREATE INDEX "proximity_encounter_user_state_owner_saved_idx" ON "proximity_encounter_user_state"("ownerUserId", "savedAt");

CREATE TABLE "proximity_encounter_flush_receipts" (
  "flushId" TEXT NOT NULL,
  "encounterId" TEXT,
  "lowerUserId" TEXT NOT NULL,
  "higherUserId" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "proximity_encounter_flush_receipts_pkey" PRIMARY KEY ("flushId"),
  CONSTRAINT "proximity_encounter_flush_receipts_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "proximity_encounter_pairs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "proximity_encounter_flush_receipts_processedAt_idx" ON "proximity_encounter_flush_receipts"("processedAt");
CREATE INDEX "proximity_encounter_flush_receipts_pair_idx" ON "proximity_encounter_flush_receipts"("lowerUserId", "higherUserId");
