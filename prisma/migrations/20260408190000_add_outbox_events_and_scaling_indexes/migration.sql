CREATE TABLE IF NOT EXISTS "outbox_events" (
    "id" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "queueName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "posts_isActive_createdAt_idx" ON "posts"("isActive", "createdAt");
CREATE INDEX IF NOT EXISTS "posts_authorId_isActive_createdAt_idx" ON "posts"("authorId", "isActive", "createdAt");
CREATE INDEX IF NOT EXISTS "connections_requesterId_status_idx" ON "connections"("requesterId", "status");
CREATE INDEX IF NOT EXISTS "connections_addresseeId_status_idx" ON "connections"("addresseeId", "status");
CREATE INDEX IF NOT EXISTS "messages_receiverId_status_createdAt_idx" ON "messages"("receiverId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");
CREATE INDEX IF NOT EXISTS "post_comments_postId_createdAt_idx" ON "post_comments"("postId", "createdAt");
CREATE INDEX IF NOT EXISTS "outbox_events_status_availableAt_createdAt_idx" ON "outbox_events"("status", "availableAt", "createdAt");
CREATE INDEX IF NOT EXISTS "outbox_events_queueName_status_createdAt_idx" ON "outbox_events"("queueName", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "outbox_events_aggregateType_aggregateId_createdAt_idx" ON "outbox_events"("aggregateType", "aggregateId", "createdAt");
