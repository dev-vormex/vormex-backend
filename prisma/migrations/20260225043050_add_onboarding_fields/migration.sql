-- AlterTable (idempotent - skip if columns exist)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'onboardingCompleted') THEN
    ALTER TABLE "users" ADD COLUMN "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'onboardingData') THEN
    ALTER TABLE "users" ADD COLUMN "onboardingData" JSONB;
  END IF;
END $$;

-- CreateTable (idempotent - skip if table exists)
CREATE TABLE IF NOT EXISTS "stories" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "thumbnailUrl" TEXT,
    "textContent" TEXT,
    "backgroundColor" TEXT,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "linkUrl" TEXT,
    "linkTitle" TEXT,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "reactionsCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent - CREATE INDEX IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS "stories_authorId_idx" ON "stories"("authorId");
CREATE INDEX IF NOT EXISTS "stories_expiresAt_idx" ON "stories"("expiresAt");
CREATE INDEX IF NOT EXISTS "stories_authorId_createdAt_idx" ON "stories"("authorId", "createdAt");

-- AddForeignKey (idempotent - skip if constraint exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stories_authorId_fkey'
  ) THEN
    ALTER TABLE "stories" ADD CONSTRAINT "stories_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
