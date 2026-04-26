CREATE TABLE "reengagement_notification_deliveries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignDateKey" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "slotHour" INTEGER NOT NULL,
    "campaignType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "reason" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reengagement_notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reengagement_notification_deliveries_userId_campaignDateKey_s_key"
ON "reengagement_notification_deliveries"("userId", "campaignDateKey", "slotKey");

CREATE INDEX "reengagement_notification_deliveries_campaignDateKey_status_idx"
ON "reengagement_notification_deliveries"("campaignDateKey", "status");

CREATE INDEX "reengagement_notification_deliveries_userId_campaignDateKey_idx"
ON "reengagement_notification_deliveries"("userId", "campaignDateKey");

ALTER TABLE "reengagement_notification_deliveries"
ADD CONSTRAINT "reengagement_notification_deliveries_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
