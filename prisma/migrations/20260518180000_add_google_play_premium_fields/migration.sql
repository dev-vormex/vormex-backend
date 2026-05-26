ALTER TABLE "subscriptions"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "googlePlayPurchaseToken" TEXT,
ADD COLUMN "googlePlayOrderId" TEXT,
ADD COLUMN "googlePlayProductId" TEXT,
ADD COLUMN "googlePlayBasePlanId" TEXT,
ADD COLUMN "googlePlaySubscriptionState" TEXT,
ADD COLUMN "googlePlayAcknowledgementState" TEXT,
ADD COLUMN "lastProviderSyncAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "subscriptions_googlePlayPurchaseToken_key"
ON "subscriptions"("googlePlayPurchaseToken");

CREATE INDEX "subscriptions_provider_idx"
ON "subscriptions"("provider");

CREATE INDEX "subscriptions_googlePlayProductId_idx"
ON "subscriptions"("googlePlayProductId");

CREATE INDEX "subscriptions_googlePlayBasePlanId_idx"
ON "subscriptions"("googlePlayBasePlanId");
