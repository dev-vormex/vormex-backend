


export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export type PremiumUsersFilter = 'all' | 'premium' | 'overrides';

export type PremiumEventsFilter = 'all' | 'clicked' | 'failed' | 'success' | 'payments';

export const chatUserSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isOnline: true,
  lastActiveAt: true,
};

export const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

export const normalizeSearch = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

export const mapEventFilterToWhere = (filter: PremiumEventsFilter) => {
  if (filter === 'clicked') {
    return { eventType: 'CLICKED_GET_PREMIUM' };
  }
  if (filter === 'failed') {
    return { outcome: 'failure' };
  }
  if (filter === 'payments') {
    return { eventType: 'CHECKOUT_VERIFIED', outcome: 'success' };
  }
  if (filter === 'success') {
    return { outcome: 'success' };
  }
  return {};
};

export const readMetadataString = (metadata: unknown, key: string): string | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export /**
 * Payment references live in the event metadata JSON, so admin responses lift them into
 * named fields. Without these, a verified payment cannot be reconciled against Razorpay.
 */
const buildEventPaymentRef = (metadata: unknown) => ({
  provider: readMetadataString(metadata, 'provider'),
  orderId: readMetadataString(metadata, 'orderId'),
  paymentId: readMetadataString(metadata, 'paymentId'),
  plan: readMetadataString(metadata, 'plan'),
  billingCycle: readMetadataString(metadata, 'billingCycle'),
  paymentMethod: readMetadataString(metadata, 'paymentMethod'),
  source: readMetadataString(metadata, 'source'),
});

export function buildChatMessagePayload(message: any, sender: any) {
  return {
    id: message.id,
    clientMessageId: message.clientMessageId || undefined,
    conversationId: message.conversationId,
    senderId: message.senderId,
    receiverId: message.receiverId,
    content: message.content,
    contentType: message.contentType,
    mediaUrl: message.mediaUrl,
    mediaType: message.mediaType,
    fileName: message.fileName,
    fileSize: message.fileSize,
    status: message.status,
    deliveredAt: message.deliveredAt?.toISOString() || null,
    readAt: message.readAt?.toISOString() || null,
    isDeleted: message.isDeleted,
    replyToId: message.replyToId,
    replyTo: message.messages || null,
    sender,
    reactions: [],
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
