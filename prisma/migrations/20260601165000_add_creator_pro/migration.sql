CREATE TABLE "creator_pro_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monetizedDmEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dmPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "sessionBookingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sessionPriceMinor" INTEGER NOT NULL DEFAULT 0,
    "sessionDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "sessionCurrency" TEXT NOT NULL DEFAULT 'INR',
    "collabPriorityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "showcaseAmplificationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "portfolioAmplificationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "availabilityNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_pro_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creator_pro_settings_userId_key" ON "creator_pro_settings"("userId");
CREATE INDEX "creator_pro_settings_collabPriorityEnabled_idx" ON "creator_pro_settings"("collabPriorityEnabled");
CREATE INDEX "creator_pro_settings_showcaseAmplificationEnabled_idx" ON "creator_pro_settings"("showcaseAmplificationEnabled");

ALTER TABLE "creator_pro_settings"
ADD CONSTRAINT "creator_pro_settings_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
