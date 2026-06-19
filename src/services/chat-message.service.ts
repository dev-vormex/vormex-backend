import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma, prismaRead } from '../config/prisma';
import { enqueueCacheInvalidation, enqueueNotificationDelivery, enqueueRealtimeFanout } from '../outbox/helpers';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';
import {
  assertUsersCanInteract,
  enforceTrustTierLimit,
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

async function getReadReceiptVisibility(userId: string): Promise<boolean> {
  try {
    return await canUserUsePremiumFeature(userId, 'read_receipts');
  } catch (error) {
    console.error('read receipt premium check failed:', error);
    return false;
  }
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
      payload: {
        conversationId: params.conversationId,
        message: params.message,
      },
    },
    {
      event: 'chat:notification',
      users: [params.receiverId],
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
  const senderRecord = await prismaRead.user.findUnique({
    where: { id: senderId },
    select: userSelect,
  });
  const senderPremiumVisibility = await getChatPremiumVisibilityByUserIds([senderId]);
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

  const conversation = await prisma.conversations.findFirst({
    where: {
      id: conversationId,
      OR: [
        { participant1Id: senderId },
        { participant2Id: senderId },
      ],
    },
  });

  if (!conversation) {
    throw new Error('Conversation not found');
  }

  const receiverId =
    conversation.participant1Id === senderId
      ? conversation.participant2Id
      : conversation.participant1Id;

  await assertUsersCanInteract(senderId, receiverId, 'message');
  await enforceTrustTierLimit(senderId, 'dm');

  const sender = await getSenderPayload(senderId);
  const viewerCanUseReadReceipts = await getReadReceiptVisibility(senderId);
  const now = new Date();
  const messageId = randomUUID();
  const preview = normalizedContent
    ? normalizedContent.length > 100
      ? normalizedContent.substring(0, 97) + '...'
      : normalizedContent
    : 'Sent you a message';

  try {
    return await prisma.$transaction(async (tx) => {
      const replyToMessage = replyToMessageId
        ? await tx.messages.findFirst({
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
        : null;

      if (replyToMessageId && !replyToMessage) {
        throw new Error('Reply target is invalid for this conversation');
      }

      await tx.messages.create({
        data: {
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
          replyToId: replyToMessageId,
          status: 'SENT',
          createdAt: now,
          updatedAt: now,
        },
      });

      await tx.conversations.update({
        where: { id: conversationId },
        data: { lastMessageAt: now, updatedAt: now },
      });

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

      await enqueueRealtimeFanout(tx, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.created',
        idempotencyKey: `chat:realtime:${messageId}`,
        envelopes: realtimeEnvelopes,
      });

      await enqueueNotificationDelivery(tx, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.push',
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

      await enqueueCacheInvalidation(tx, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.cache.invalidate',
        idempotencyKey: `chat:cache:${messageId}`,
        tags: cacheTags,
      });

      return {
        conversationId,
        receiverId,
        message,
        realtimeEnvelopes,
        wasDuplicate: false,
      };
    }, {
      maxWait: 15_000,
      timeout: 15_000,
    });
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
