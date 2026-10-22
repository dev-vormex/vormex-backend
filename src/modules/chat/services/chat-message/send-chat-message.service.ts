import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma, prismaRead } from "../../../../config/prisma";
import type { OutboxEventInput } from "../../../../infrastructure/outbox/types";
import { queueNames } from "../../../../infrastructure/queue/queue-names";
import { logger } from "../../../../infrastructure/logging/logger";
import { getConversationPeerIdCached } from "../chat-conversation-cache.service";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { assertUsersCanMessageCached, enforceTrustTierLimit } from "../../../safety/services/trust-safety.service";
import { SendChatMessageInput, SendChatMessageResult, normalizeOptionalString, normalizeFileSize, normalizeClientMessageId, getReadReceiptVisibilityCached, resolveChatPushDeliveryMode, conversationCacheTags } from "./normalize-client-message-id.service";
import { getChatSenderPayloadCached, mapChatMessagePayload, buildRealtimeEnvelopes, isPrismaUniqueViolation, getExistingMessageResult } from "./get-chat-sender-payload-cached.service";

export async function sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult> {
  const senderId = input.senderId;
  const conversationId = input.conversationId;
  const normalizedContent = normalizeOptionalString(input.content) || '';
  const normalizedMediaUrl = normalizeOptionalString(input.mediaUrl);
  const normalizedContentType = normalizeOptionalString(input.contentType) || 'text';
  const normalizedMediaType = normalizeOptionalString(input.mediaType);
  const normalizedFileName = normalizeOptionalString(input.fileName);
  const normalizedFileSize = normalizeFileSize(input.fileSize);
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);
  const replyToMessageId = normalizeOptionalString(input.replyToId);

  if (!conversationId) {
    throw new Error('Conversation ID is required');
  }

  if (!normalizedContent && !normalizedMediaUrl) {
    throw new Error('Content or media is required');
  }

  const receiverId = await getConversationPeerIdCached(conversationId, senderId);
  if (!receiverId) {
    throw new Error('Conversation not found');
  }

  // Every one of these previously ran serially before the sender's ack; on a
  // high-latency DB link that alone added seconds. Safety checks stay live,
  // identity/premium lookups are memoized, and everything runs concurrently.
  const [, , sender, viewerCanUseReadReceipts, replyToMessage] = await Promise.all([
    assertUsersCanMessageCached(senderId, receiverId),
    enforceTrustTierLimit(senderId, 'dm'),
    getChatSenderPayloadCached(senderId),
    getReadReceiptVisibilityCached(senderId),
    replyToMessageId
      ? prismaRead.messages.findFirst({
          where: {
            id: replyToMessageId,
            conversationId,
            isDeleted: false,
          },
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
          },
        })
      : Promise.resolve(null),
  ]);

  if (replyToMessageId && !replyToMessage) {
    throw new Error('Reply target is invalid for this conversation');
  }

  const now = new Date();
  const messageId = randomUUID();
  const preview = normalizedContent
    ? normalizedContent.length > 100
      ? normalizedContent.substring(0, 97) + '...'
      : normalizedContent
    : 'Sent you a message';
  const pushDeliveryMode = resolveChatPushDeliveryMode();

  const message = mapChatMessagePayload({
    message: {
      id: messageId,
      clientMessageId,
      conversationId,
      senderId,
      receiverId,
      content: normalizedContent,
      contentType: normalizedContentType,
      mediaUrl: normalizedMediaUrl,
      mediaType: normalizedMediaType,
      fileName: normalizedFileName,
      fileSize: normalizedFileSize,
      status: 'SENT',
      deliveredAt: null,
      readAt: null,
      editedAt: null,
      isDeleted: false,
      replyToId: replyToMessageId,
      messages: replyToMessage,
      createdAt: now,
      updatedAt: now,
    },
    sender,
    viewerUserId: senderId,
    viewerCanUseReadReceipts,
  });

  const realtimeEnvelopes = buildRealtimeEnvelopes({
    conversationId,
    message,
    receiverId,
    sender,
    senderId,
  });
  const cacheTags = conversationCacheTags(conversationId, senderId, receiverId);

  const outboxEvents: OutboxEventInput[] = [
    {
      aggregateType: 'message',
      aggregateId: messageId,
      eventType: 'chat.message.created',
      queueName: queueNames.realtimeFanout,
      idempotencyKey: `chat:realtime:${messageId}`,
      payload: { envelopes: realtimeEnvelopes },
    },
  ];

  if (pushDeliveryMode === 'outbox') {
    outboxEvents.push({
      aggregateType: 'message',
      aggregateId: messageId,
      eventType: 'chat.message.push',
      queueName: queueNames.notificationDelivery,
      idempotencyKey: `chat:push:${messageId}`,
      payload: {
        kind: 'new_message',
        userId: receiverId,
        title: sender?.name || sender?.username || 'Someone',
        body: preview,
        conversationId,
        senderId,
        senderName: sender?.name || sender?.username || 'Someone',
        senderImage: sender?.profileImage || undefined,
        messageId,
        clientMessageId: clientMessageId || undefined,
        messageContent: normalizedContent,
        contentType: normalizedContentType,
        mediaUrl: normalizedMediaUrl || undefined,
        mediaType: normalizedMediaType || undefined,
        fileName: normalizedFileName || undefined,
        fileSize: normalizedFileSize || undefined,
        messageCreatedAt: now.toISOString(),
        messageUpdatedAt: now.toISOString(),
      },
    });
  }

  outboxEvents.push({
    aggregateType: 'conversation',
    aggregateId: conversationId,
    eventType: 'chat.cache.invalidate',
    queueName: queueNames.cacheInvalidation,
    idempotencyKey: `chat:cache:${messageId}`,
    payload: { tags: cacheTags },
  });

  try {
    const outboxRows = outboxEvents.map((event) => Prisma.sql`(
      ${randomUUID()},
      ${event.aggregateType},
      ${event.aggregateId},
      ${event.eventType},
      ${event.queueName},
      ${event.idempotencyKey || null},
      ${JSON.stringify(event.payload)}::jsonb,
      ${event.availableAt || now},
      ${now}
    )`);

    // One data-modifying CTE is one atomic PostgreSQL statement. This keeps
    // the durability guarantee of the previous interactive transaction while
    // avoiding several serial network round-trips to a remote database.
    await prisma.$executeRaw(Prisma.sql`
      WITH inserted_message AS (
        INSERT INTO "messages" (
          "id",
          "clientMessageId",
          "conversationId",
          "senderId",
          "receiverId",
          "content",
          "contentType",
          "mediaUrl",
          "mediaType",
          "fileName",
          "fileSize",
          "status",
          "replyToId",
          "createdAt",
          "updatedAt"
        ) VALUES (
          ${messageId},
          ${clientMessageId},
          ${conversationId},
          ${senderId},
          ${receiverId},
          ${normalizedContent},
          ${normalizedContentType},
          ${normalizedMediaUrl},
          ${normalizedMediaType},
          ${normalizedFileName},
          ${normalizedFileSize},
          'SENT',
          ${replyToMessageId},
          ${now},
          ${now}
        )
        RETURNING "id"
      ),
      inserted_outbox AS (
        INSERT INTO "outbox_events" (
          "id",
          "aggregateType",
          "aggregateId",
          "eventType",
          "queueName",
          "idempotencyKey",
          "payload",
          "availableAt",
          "updatedAt"
        )
        VALUES ${Prisma.join(outboxRows)}
        ON CONFLICT ("idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL
        DO NOTHING
        RETURNING "id"
      )
      UPDATE "conversations"
      SET "lastMessageAt" = ${now},
          "updatedAt" = ${now},
          "hiddenForUserIds" = array_remove(
            array_remove("hiddenForUserIds", ${senderId}),
            ${receiverId}
          )
      WHERE "id" = ${conversationId}
        AND EXISTS (SELECT 1 FROM inserted_message)
        AND (SELECT COUNT(*) FROM inserted_outbox) >= 0
    `);

    const result = {
      conversationId,
      receiverId,
      message,
      realtimeEnvelopes,
      wasDuplicate: false,
    };

    if (pushDeliveryMode === 'direct') {
      void pushNotificationService.pushNewMessage(
        result.receiverId,
        result.message.sender.name || result.message.sender.username || 'Someone',
        preview,
        result.conversationId,
        result.message.senderId,
        result.message.sender.profileImage || undefined,
        {
          id: result.message.id,
          clientMessageId: result.message.clientMessageId,
          content: result.message.content,
          contentType: result.message.contentType,
          mediaUrl: result.message.mediaUrl,
          mediaType: result.message.mediaType,
          fileName: result.message.fileName,
          fileSize: result.message.fileSize,
          createdAt: result.message.createdAt,
          updatedAt: result.message.updatedAt,
        }
      ).then((sent) => {
        if (!sent) {
          logger.warn({
            event: 'chat.message.direct_push_failed',
            messageId: result.message.id,
            conversationId: result.conversationId,
            receiverId: result.receiverId,
          });
        }
      }).catch((error) => {
        logger.error({
          event: 'chat.message.direct_push_error',
          messageId: result.message.id,
          conversationId: result.conversationId,
          receiverId: result.receiverId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return result;
  } catch (error) {
    if (clientMessageId && isPrismaUniqueViolation(error)) {
      const existing = await getExistingMessageResult({
        clientMessageId,
        conversationId,
        sender,
        senderId,
        viewerCanUseReadReceipts,
      });
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}
