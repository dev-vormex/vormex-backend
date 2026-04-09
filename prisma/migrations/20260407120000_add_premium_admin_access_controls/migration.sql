-- CreateTable
CREATE TABLE "app_feature_settings" (
    "id" TEXT NOT NULL,
    "premiumDefaultAmountMinor" INTEGER NOT NULL DEFAULT 19900,
    "premiumCurrency" TEXT NOT NULL DEFAULT 'INR',
    "agentAvailabilityMode" TEXT NOT NULL DEFAULT 'all',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_feature_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_feature_access_overrides" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "premiumPriceOverrideMinor" INTEGER,
    "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "profileCustomizationGranted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_feature_access_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premium_checkout_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "premium_checkout_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_feature_access_overrides_userId_key" ON "user_feature_access_overrides"("userId");

-- CreateIndex
CREATE INDEX "user_feature_access_overrides_agentEnabled_idx" ON "user_feature_access_overrides"("agentEnabled");

-- CreateIndex
CREATE INDEX "user_feature_access_overrides_profileCustomizationGranted_idx" ON "user_feature_access_overrides"("profileCustomizationGranted");

-- CreateIndex
CREATE INDEX "premium_checkout_events_userId_createdAt_idx" ON "premium_checkout_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "premium_checkout_events_eventType_createdAt_idx" ON "premium_checkout_events"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "premium_checkout_events_outcome_createdAt_idx" ON "premium_checkout_events"("outcome", "createdAt");

-- AddForeignKey
ALTER TABLE "user_feature_access_overrides"
ADD CONSTRAINT "user_feature_access_overrides_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premium_checkout_events"
ADD CONSTRAINT "premium_checkout_events_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed singleton settings row
INSERT INTO "app_feature_settings" ("id", "createdAt", "updatedAt")
VALUES ('default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
