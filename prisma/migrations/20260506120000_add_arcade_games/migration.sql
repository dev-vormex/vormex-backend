-- CreateTable
CREATE TABLE "arcade_rooms" (
    "id" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "guestId" TEXT,
    "inviteCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "hostReady" BOOLEAN NOT NULL DEFAULT false,
    "guestReady" BOOLEAN NOT NULL DEFAULT false,
    "seed" INTEGER NOT NULL DEFAULT 0,
    "hostScore" INTEGER NOT NULL DEFAULT 0,
    "guestScore" INTEGER NOT NULL DEFAULT 0,
    "winnerId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "arcade_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arcade_results" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "opponentId" TEXT,
    "result" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "opponentScore" INTEGER NOT NULL DEFAULT 0,
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "coinsEarned" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arcade_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "arcade_rooms_inviteCode_key" ON "arcade_rooms"("inviteCode");
CREATE INDEX "arcade_rooms_gameType_status_idx" ON "arcade_rooms"("gameType", "status");
CREATE INDEX "arcade_rooms_hostId_idx" ON "arcade_rooms"("hostId");
CREATE INDEX "arcade_rooms_guestId_idx" ON "arcade_rooms"("guestId");
CREATE INDEX "arcade_rooms_status_idx" ON "arcade_rooms"("status");
CREATE INDEX "arcade_rooms_createdAt_idx" ON "arcade_rooms"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "arcade_results_roomId_userId_key" ON "arcade_results"("roomId", "userId");
CREATE INDEX "arcade_results_gameType_idx" ON "arcade_results"("gameType");
CREATE INDEX "arcade_results_userId_createdAt_idx" ON "arcade_results"("userId", "createdAt");
CREATE INDEX "arcade_results_opponentId_idx" ON "arcade_results"("opponentId");
CREATE INDEX "arcade_results_result_idx" ON "arcade_results"("result");

-- AddForeignKey
ALTER TABLE "arcade_rooms" ADD CONSTRAINT "arcade_rooms_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "arcade_rooms" ADD CONSTRAINT "arcade_rooms_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "arcade_rooms" ADD CONSTRAINT "arcade_rooms_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "arcade_results" ADD CONSTRAINT "arcade_results_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "arcade_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "arcade_results" ADD CONSTRAINT "arcade_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "arcade_results" ADD CONSTRAINT "arcade_results_opponentId_fkey" FOREIGN KEY ("opponentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
