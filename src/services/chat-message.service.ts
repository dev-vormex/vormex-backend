import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma, prismaRead } from '../config/prisma';
import type { OutboxEventInput } from '../outbox/types';
import { queueNames } from '../infrastructure/queue/queue-names';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';
import { TtlMemo } from '../infrastructure/cache/ttl-memo';
import { logger } from '../lib/logger';
import { getConversationPeerIdCached } from './chat-conversation-cache.service';
import { pushNotificationService } from './push-notification.service';
import {
  assertUsersCanMessageCached,
  enforceTrustTierLimit,
  getIdentityTrustLevelCached,
  publicTrustFields,
  safetyErrorResponse,
  trustLevelRank,
} from './trust-safety.service';
import {
  getPremiumVisibilityByUserIds,
  type PremiumVisibilityState,
} from './premium-visibility.service';
import { canUserUsePremiumFeature } from './premium-feature-gates.service';
import { maskReadReceiptForViewer } from './chat-read-receipts.service';

type ChatUserRecord = {
  id: string;
  username: string | null;
  name: string | null;
  profileImage: string | null;
  isOnline: boolean;
  lastActiveAt: Date | null;
  isVerified: boolean;
  profileBadgeStyle: string | null;
  identityTrustLevel: string | null;
};

type ChatSenderPayload = ChatUserRecord & {
  profileBadgeStyle: string | null;
  isPremium: boolean;
  identityTrustLevel: string;
  verificationBadges: string[];
};

type ReplyMessagePayload = {
  id: string;
  content: string;
  contentType: string;
  senderId: string;
} | null;

type MessageRecordForPayload = {
  id: string;
  clientMessageId: string | null;
  conversationId: string;
  senderId: string;
  receiverId: string;
  content: string;
  contentType: string;
  mediaUrl: string | null;
  mediaType: string | null;
  fileName: string | null;
  fileSize: number | null;
  status: string;
  deliveredAt: Date | string | null;
  readAt: Date | string | null;
  editedAt?: Date | string | null;
  isDeleted: boolean;
  replyToId: string | null;
  messages?: ReplyMessagePayload;
  createdAt: Date;
  updatedAt: Date;
};

export type ChatMessagePayload = {
  id: string;
  clientMessageId?: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  content: string;
  contentType: string;
  mediaUrl: string | null;
  mediaType: string | null;
  fileName: string | null;
  fileSize: number | null;
  status: string;
  deliveredAt?: string;
  readAt?: string;
  editedAt?: string;
  isEdited: boolean;
  isDeleted: boolean;
  replyToId: string | null;
  replyTo: ReplyMessagePayload | undefined;
  sender: ChatSenderPayload;
  reactions: Array<{
    id: string;
    userId: string;
    emoji: string;
    user: { id: string; username: string; name: string };
  }>;
  createdAt: string;
  updatedAt: string;
};

export type SendChatMessageInput = {
  senderId: string;
  conversationId: string;
  content?: unknown;
  contentType?: unknown;
  mediaUrl?: unknown;
  mediaType?: unknown;
  fileName?: unknown;
  fileSize?: unknown;
  replyToId?: unknown;
  clientMessageId?: unknown;
};

export type SendChatMessageResult = {
  conversationId: string;
  receiverId: string;
  message: ChatMessagePayload;
  realtimeEnvelopes: RealtimeEnvelope[];
  wasDuplicate: boolean;
};

const userSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isOnline: true,
  lastActiveAt: true,
  isVerified: true,
  profileBadgeStyle: true,
  identityTrustLevel: true,
};

const uniqueTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

const chatUserCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueTags(userIds.filter(Boolean).map((userId) => `chat:user:${userId}`));

const notificationCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueTags(userIds.filter(Boolean).map((userId) => `notifications:${userId}`));

const conversationCacheTags = (
  conversationId: string,
  ...participantIds: Array<string | null | undefined>
): string[] =>
  uniqueTags([
    `conversation:${conversationId}`,
    ...chatUserCacheTags(...participantIds),
    ...notificationCacheTags(...participantIds),
  ]);

export const normalizeClientMessageId = (clientMessageId: unknown): string | null => {
  if (typeof clientMessageId !== 'string') {
    return null;
  }

  const normalized = clientMessageId.trim();
  return normalized ? normalized.slice(0, 128) : null;
};

export type ChatPushDeliveryMode = 'direct' | 'outbox';

/**
 * Local development commonly runs only the API process, without Redis-backed
 * workers. Deliver chat pushes directly there so background notifications keep
 * working. Production keeps the transactional outbox as the durable default.
 */
export function resolveChatPushDeliveryMode(
  configuredMode = process.env.CHAT_PUSH_DELIVERY_MODE,
  nodeEnv = process.env.NODE_ENV
): ChatPushDeliveryMode {
  const normalizedMode = configuredMode?.trim().toLowerCase();
  if (normalizedMode === 'direct' || normalizedMode === 'outbox') {
    return normalizedMode;
  }

  return nodeEnv === 'production' ? 'outbox' : 'direct';
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = String(value);
  return stringValue.length > 0 ? stringValue : null;
}

function normalizeFileSize(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

function buildFallbackChatUser(userId: string): ChatSenderPayload {
  return {
    id: userId,
    username: '',
    name: '',
    profileImage: null,
    isOnline: false,
    lastActiveAt: null,
    isVerified: false,
    profileBadgeStyle: null,
    identityTrustLevel: 'BASIC',
    verificationBadges: [],
    isPremium: false,
  };
}

function buildChatUserIdentity(
  user: ChatUserRecord,
  premiumVisibilityByUser: Map<string, Pick<PremiumVisibilityState, 'isPremium'>>
): ChatSenderPayload {
  const isPremium = Boolean(user.id && premiumVisibilityByUser.get(user.id)?.isPremium);
  const earnedStudentBadge =
    user.profileBadgeStyle?.toLowerCase() === 'student' &&
    trustLevelRank(user.identityTrustLevel) >= trustLevelRank('STUDENT_VERIFIED');

  return {
    ...user,
    username: user.username || '',
    name: user.name || '',
    profileBadgeStyle: isPremium || earnedStudentBadge ? user.profileBadgeStyle ?? null : null,
    isPremium,
    ...publicTrustFields(user.identityTrustLevel),
  };
}

async function getChatPremiumVisibilityByUserIds(
  userIds: string[]
): Promise<Map<string, PremiumVisibilityState>> {
  try {
    return await getPremiumVisibilityByUserIds(userIds);
  } catch (error) {
    console.error('chat premium visibility lookup failed:', error);
    return new Map();
  }
}

// Identity/premium flags tolerate short staleness; both lookups fan out into
// several DB queries each and sit on the ack critical path of every send.
const CHAT_IDENTITY_MEMO_TTL_MS = 45_000;
const senderPayloadMemo = new TtlMemo<ChatSenderPayload | null>(CHAT_IDENTITY_MEMO_TTL_MS, 10_000);
const readReceiptMemo = new TtlMemo<boolean>(CHAT_IDENTITY_MEMO_TTL_MS, 10_000);

async function getReadReceiptVisibility(userId: string): Promise<boolean> {
  try {
    return await canUserUsePremiumFeature(userId, 'read_receipts');
  } catch (error) {
    console.error('read receipt premium check failed:', error);
    return false;
  }
}

export async function getReadReceiptVisibilityCached(userId: string): Promise<boolean> {
  return readReceiptMemo.get(userId, () => getReadReceiptVisibility(userId));
}

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

export function invalidateChatIdentityCache(userId: string): void {
  senderPayloadMemo.delete(userId);
  readReceiptMemo.delete(userId);
}

function toIsoString(value: Date | string | null): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function mapChatMessagePayload(params: {
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

function buildRealtimeEnvelopes(params: {
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

function isPrismaUniqueViolation(error: unknown): boolean {
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

async function getExistingMessageResult(params: {
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

export function getSafetyErrorResponse(error: unknown) {
  return safetyErrorResponse(error);
}

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
      SET "lastMessageAt" = ${now}, "updatedAt" = ${now}
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
