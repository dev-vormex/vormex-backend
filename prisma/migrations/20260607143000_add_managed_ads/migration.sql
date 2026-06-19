CREATE TABLE "managed_ad_campaigns" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sponsorName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "placements" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "priority" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "frequencyCapPerDay" INTEGER NOT NULL DEFAULT 3,
  "ctaText" TEXT,
  "ctaKind" TEXT,
  "ctaUrl" TEXT,
  "feedTitle" TEXT,
  "feedBody" TEXT,
  "feedImageUrl" TEXT,
  "reelCaption" TEXT,
  "reelsVideoUrl" TEXT,
  "reelsHlsUrl" TEXT,
  "reelsThumbnailUrl" TEXT,
  "targeting" JSONB,
  "impressionsCount" INTEGER NOT NULL DEFAULT 0,
  "clicksCount" INTEGER NOT NULL DEFAULT 0,
  "createdByAdminId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_ad_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "managed_ad_events" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "userId" TEXT,
  "eventType" TEXT NOT NULL,
  "placement" TEXT NOT NULL,
  "slotKey" TEXT,
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "managed_ad_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "managed_ad_campaigns_status_startsAt_endsAt_idx" ON "managed_ad_campaigns"("status", "startsAt", "endsAt");
CREATE INDEX "managed_ad_campaigns_priority_idx" ON "managed_ad_campaigns"("priority");
CREATE INDEX "managed_ad_campaigns_createdByAdminId_idx" ON "managed_ad_campaigns"("createdByAdminId");

CREATE INDEX "managed_ad_events_campaignId_eventType_createdAt_idx" ON "managed_ad_events"("campaignId", "eventType", "createdAt");
CREATE INDEX "managed_ad_events_userId_eventType_createdAt_idx" ON "managed_ad_events"("userId", "eventType", "createdAt");
CREATE INDEX "managed_ad_events_sessionId_placement_createdAt_idx" ON "managed_ad_events"("sessionId", "placement", "createdAt");

ALTER TABLE "managed_ad_campaigns"
  ADD CONSTRAINT "managed_ad_campaigns_createdByAdminId_fkey"
  FOREIGN KEY ("createdByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "managed_ad_events"
  ADD CONSTRAINT "managed_ad_events_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "managed_ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_ad_events"
  ADD CONSTRAINT "managed_ad_events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
