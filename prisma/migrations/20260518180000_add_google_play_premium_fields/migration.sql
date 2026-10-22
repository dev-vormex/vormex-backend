ALTER TABLE "subscriptions"
ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS "googlePlayPurchaseToken" TEXT,
ADD COLUMN IF NOT EXISTS "googlePlayOrderId" TEXT,
ADD COLUMN IF NOT EXISTS "googlePlayProductId" TEXT,
ADD COLUMN IF NOT EXISTS "googlePlayBasePlanId" TEXT,
ADD COLUMN IF NOT EXISTS "googlePlaySubscriptionState" TEXT,
ADD COLUMN IF NOT EXISTS "googlePlayAcknowledgementState" TEXT,
ADD COLUMN IF NOT EXISTS "lastProviderSyncAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_googlePlayPurchaseToken_key"
ON "subscriptions"("googlePlayPurchaseToken");

CREATE INDEX IF NOT EXISTS "subscriptions_provider_idx"
ON "subscriptions"("provider");

CREATE INDEX IF NOT EXISTS "subscriptions_googlePlayProductId_idx"
ON "subscriptions"("googlePlayProductId");

CREATE INDEX IF NOT EXISTS "subscriptions_googlePlayBasePlanId_idx"
ON "subscriptions"("googlePlayBasePlanId");
