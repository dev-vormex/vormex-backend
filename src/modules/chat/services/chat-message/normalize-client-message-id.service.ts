import type { RealtimeEnvelope } from "../../../../infrastructure/realtime/channels";
import { TtlMemo } from "../../../../infrastructure/cache/ttl-memo";
import { publicTrustFields, trustLevelRank } from "../../../safety/services/trust-safety.service";
import { getPremiumVisibilityByUserIds, type PremiumVisibilityState } from "../../../premium/services/premium-visibility.service";
import { canUserUsePremiumFeature } from "../../../premium/services/premium-feature-gates.service";

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

export type ChatSenderPayload = ChatUserRecord & {
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

export type MessageRecordForPayload = {
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

export const userSelect = {
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

export const conversationCacheTags = (
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

export function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = String(value);
  return stringValue.length > 0 ? stringValue : null;
}

export function normalizeFileSize(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

export function buildFallbackChatUser(userId: string): ChatSenderPayload {
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

export function buildChatUserIdentity(
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

export async function getChatPremiumVisibilityByUserIds(
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

export const senderPayloadMemo = new TtlMemo<ChatSenderPayload | null>(CHAT_IDENTITY_MEMO_TTL_MS, 10_000);

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
