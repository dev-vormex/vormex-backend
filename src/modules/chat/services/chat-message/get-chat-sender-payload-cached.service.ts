import { Prisma } from "@prisma/client";
import { prismaRead } from "../../../../config/prisma";
import type { RealtimeEnvelope } from "../../../../infrastructure/realtime/channels";
import { getConversationPeerIdCached } from "../chat-conversation-cache.service";
import { assertUsersCanMessageCached, getIdentityTrustLevelCached } from "../../../safety/services/trust-safety.service";
import { maskReadReceiptForViewer } from "../chat-read-receipts.service";
import { ChatSenderPayload, senderPayloadMemo, getReadReceiptVisibilityCached, MessageRecordForPayload, ChatMessagePayload, buildFallbackChatUser, userSelect, getChatPremiumVisibilityByUserIds, buildChatUserIdentity, SendChatMessageResult } from "./normalize-client-message-id.service";

export async function getChatSenderPayloadCached(senderId: string): Promise<ChatSenderPayload | null> {
  return senderPayloadMemo.get(senderId, () => getSenderPayload(senderId));
}

/**
 * Warm remote-DB lookups while a user is already reading/typing in the chat,
 * before the send button is pressed. The send path still awaits and enforces
 * every check; it simply reuses the same short-lived promises/results.
 */
export async function warmChatSendPath(conversationId: string, senderId: string): Promise<void> {
  const receiverId = await getConversationPeerIdCached(conversationId, senderId);
  if (!receiverId) return;

  await Promise.all([
    assertUsersCanMessageCached(senderId, receiverId),
    getIdentityTrustLevelCached(senderId),
    getChatSenderPayloadCached(senderId),
    getReadReceiptVisibilityCached(senderId),
  ]);
}

function toIsoString(value: Date | string | null): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

export function mapChatMessagePayload(params: {
  message: MessageRecordForPayload;
  reactions?: Array<{ id: string; userId: string; emoji: string }>;
  sender: ChatSenderPayload | null;
  viewerUserId: string;
  viewerCanUseReadReceipts: boolean;
}): ChatMessagePayload {
  const visibleMessage = maskReadReceiptForViewer(
    params.message,
    params.viewerUserId,
    params.viewerCanUseReadReceipts
  );

  return {
    id: visibleMessage.id,
    clientMessageId: visibleMessage.clientMessageId || undefined,
    conversationId: visibleMessage.conversationId,
    senderId: visibleMessage.senderId,
    receiverId: visibleMessage.receiverId,
    content: visibleMessage.content,
    contentType: visibleMessage.contentType,
    mediaUrl: visibleMessage.mediaUrl,
    mediaType: visibleMessage.mediaType,
    fileName: visibleMessage.fileName,
    fileSize: visibleMessage.fileSize,
    status: visibleMessage.status,
    deliveredAt: toIsoString(visibleMessage.deliveredAt),
    readAt: toIsoString(visibleMessage.readAt),
    editedAt: toIsoString(visibleMessage.editedAt ?? null),
    isEdited: Boolean(visibleMessage.editedAt),
    isDeleted: visibleMessage.isDeleted,
    replyToId: visibleMessage.replyToId,
    replyTo: visibleMessage.messages,
    sender: params.sender || buildFallbackChatUser(visibleMessage.senderId),
    reactions: (params.reactions || []).map((reaction) => ({
      id: reaction.id,
      userId: reaction.userId,
      emoji: reaction.emoji,
      user: { id: reaction.userId, username: '', name: '' },
    })),
    createdAt: visibleMessage.createdAt.toISOString(),
    updatedAt: visibleMessage.updatedAt.toISOString(),
  };
}

export function buildRealtimeEnvelopes(params: {
  conversationId: string;
  message: ChatMessagePayload;
  receiverId: string;
  sender: ChatSenderPayload | null;
  senderId: string;
}): RealtimeEnvelope[] {
  return [
    {
      event: 'chat:new_message',
      rooms: [`chat:${params.conversationId}`],
      users: [params.senderId, params.receiverId],
      dedupeKey: `chat:new_message:${params.message.id}`,
      payload: {
        conversationId: params.conversationId,
        message: params.message,
      },
    },
    {
      event: 'chat:notification',
      users: [params.receiverId],
      dedupeKey: `chat:notification:${params.message.id}`,
      payload: {
        type: 'new_message',
        conversationId: params.conversationId,
        message: params.message,
        sender: params.sender,
      },
    },
  ];
}

export function isPrismaUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function getSenderPayload(senderId: string): Promise<ChatSenderPayload | null> {
  const [senderRecord, senderPremiumVisibility] = await Promise.all([
    prismaRead.user.findUnique({
      where: { id: senderId },
      select: userSelect,
    }),
    getChatPremiumVisibilityByUserIds([senderId]),
  ]);
  return senderRecord ? buildChatUserIdentity(senderRecord, senderPremiumVisibility) : null;
}

export async function getExistingMessageResult(params: {
  clientMessageId: string;
  conversationId: string;
  sender: ChatSenderPayload | null;
  senderId: string;
  viewerCanUseReadReceipts: boolean;
}): Promise<SendChatMessageResult | null> {
  const existingMessage = await prismaRead.messages.findFirst({
    where: {
      senderId: params.senderId,
      clientMessageId: params.clientMessageId,
    },
    include: {
      message_reactions: true,
      messages: {
        select: {
          id: true,
          content: true,
          contentType: true,
          senderId: true,
        },
      },
    },
  });

  if (!existingMessage) {
    return null;
  }

  const message = mapChatMessagePayload({
    message: existingMessage,
    reactions: existingMessage.message_reactions,
    sender: params.sender,
    viewerUserId: params.senderId,
    viewerCanUseReadReceipts: params.viewerCanUseReadReceipts,
  });
  const receiverId = existingMessage.receiverId;

  return {
    conversationId: existingMessage.conversationId,
    receiverId,
    message,
    realtimeEnvelopes: [],
    wasDuplicate: true,
  };
}
