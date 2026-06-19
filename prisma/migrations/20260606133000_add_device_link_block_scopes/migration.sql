-- Cross-account block evasion protection.
-- Raw client install IDs are never stored; only server-HMAC hashes are persisted.

CREATE TABLE "user_devices" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "installHash" TEXT NOT NULL,
  "platform" TEXT NOT NULL DEFAULT 'unknown',
  "userAgentHash" TEXT,
  "ipHash" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_block_device_scopes" (
  "id" TEXT NOT NULL,
  "blockId" TEXT NOT NULL,
  "blockerId" TEXT NOT NULL,
  "installHash" TEXT NOT NULL,
  "platform" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_block_device_scopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_devices_userId_installHash_key" ON "user_devices"("userId", "installHash");
CREATE INDEX "user_devices_installHash_idx" ON "user_devices"("installHash");
CREATE INDEX "user_devices_userId_lastSeenAt_idx" ON "user_devices"("userId", "lastSeenAt");
CREATE INDEX "user_devices_platform_lastSeenAt_idx" ON "user_devices"("platform", "lastSeenAt");

CREATE UNIQUE INDEX "user_block_device_scopes_blockId_installHash_key" ON "user_block_device_scopes"("blockId", "installHash");
CREATE INDEX "user_block_device_scopes_blockerId_installHash_idx" ON "user_block_device_scopes"("blockerId", "installHash");
CREATE INDEX "user_block_device_scopes_installHash_idx" ON "user_block_device_scopes"("installHash");

ALTER TABLE "user_devices"
  ADD CONSTRAINT "user_devices_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_block_device_scopes"
  ADD CONSTRAINT "user_block_device_scopes_blockId_fkey"
  FOREIGN KEY ("blockId") REFERENCES "user_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_block_device_scopes"
  ADD CONSTRAINT "user_block_device_scopes_blockerId_fkey"
  FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
