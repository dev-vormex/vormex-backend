-- CreateTable
CREATE TABLE "post_collaborators" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "post_collaborators_postId_userId_key" ON "post_collaborators"("postId", "userId");

-- CreateIndex
CREATE INDEX "post_collaborators_postId_status_idx" ON "post_collaborators"("postId", "status");

-- CreateIndex
CREATE INDEX "post_collaborators_userId_status_idx" ON "post_collaborators"("userId", "status");

-- CreateIndex
CREATE INDEX "post_collaborators_invitedById_idx" ON "post_collaborators"("invitedById");

-- AddForeignKey
ALTER TABLE "post_collaborators" ADD CONSTRAINT "post_collaborators_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_collaborators" ADD CONSTRAINT "post_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_collaborators" ADD CONSTRAINT "post_collaborators_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
