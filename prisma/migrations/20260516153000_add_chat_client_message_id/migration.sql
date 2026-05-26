ALTER TABLE "messages" ADD COLUMN "clientMessageId" TEXT;

CREATE UNIQUE INDEX "messages_conversationId_senderId_clientMessageId_key"
ON "messages"("conversationId", "senderId", "clientMessageId");
