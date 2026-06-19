CREATE TABLE "discovery_impressions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'for_you',
  "windowStart" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discovery_impressions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "discovery_passes" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'for_you',
  "status" TEXT NOT NULL DEFAULT 'active',
  "passedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rewoundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "discovery_passes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "saved_discovery_searches" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "filters" JSONB NOT NULL,
  "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
  "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastScannedAt" TIMESTAMP(3),
  "lastDigestSentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saved_discovery_searches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "saved_discovery_search_matches" (
  "id" TEXT NOT NULL,
  "savedSearchId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "firstMatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seenAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  "digestSentAt" TIMESTAMP(3),
  CONSTRAINT "saved_discovery_search_matches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discovery_impressions_userId_targetUserId_source_windowStart_key"
  ON "discovery_impressions"("userId", "targetUserId", "source", "windowStart");
CREATE INDEX "discovery_impressions_userId_source_windowStart_idx"
  ON "discovery_impressions"("userId", "source", "windowStart");
CREATE INDEX "discovery_impressions_targetUserId_idx"
  ON "discovery_impressions"("targetUserId");

CREATE UNIQUE INDEX "discovery_passes_userId_targetUserId_source_key"
  ON "discovery_passes"("userId", "targetUserId", "source");
CREATE INDEX "discovery_passes_userId_source_status_passedAt_idx"
  ON "discovery_passes"("userId", "source", "status", "passedAt");
CREATE INDEX "discovery_passes_targetUserId_idx"
  ON "discovery_passes"("targetUserId");

CREATE INDEX "saved_discovery_searches_userId_updatedAt_idx"
  ON "saved_discovery_searches"("userId", "updatedAt");
CREATE INDEX "saved_discovery_searches_notificationsEnabled_digestEnabled_lastDigestSentAt_idx"
  ON "saved_discovery_searches"("notificationsEnabled", "digestEnabled", "lastDigestSentAt");

CREATE UNIQUE INDEX "saved_discovery_search_matches_savedSearchId_targetUserId_key"
  ON "saved_discovery_search_matches"("savedSearchId", "targetUserId");
CREATE INDEX "saved_discovery_search_matches_savedSearchId_seenAt_firstMatchedAt_idx"
  ON "saved_discovery_search_matches"("savedSearchId", "seenAt", "firstMatchedAt");
CREATE INDEX "saved_discovery_search_matches_savedSearchId_digestSentAt_idx"
  ON "saved_discovery_search_matches"("savedSearchId", "digestSentAt");
CREATE INDEX "saved_discovery_search_matches_targetUserId_idx"
  ON "saved_discovery_search_matches"("targetUserId");

ALTER TABLE "discovery_impressions"
  ADD CONSTRAINT "discovery_impressions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discovery_impressions"
  ADD CONSTRAINT "discovery_impressions_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "discovery_passes"
  ADD CONSTRAINT "discovery_passes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discovery_passes"
  ADD CONSTRAINT "discovery_passes_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_discovery_searches"
  ADD CONSTRAINT "saved_discovery_searches_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_discovery_search_matches"
  ADD CONSTRAINT "saved_discovery_search_matches_savedSearchId_fkey"
  FOREIGN KEY ("savedSearchId") REFERENCES "saved_discovery_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_discovery_search_matches"
  ADD CONSTRAINT "saved_discovery_search_matches_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
