import type { QueueName } from '../infrastructure/queue/queue-names';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  availableAt?: Date;
  idempotencyKey?: string;
}

export type CacheInvalidationPayload =
  | {
      tags: string[];
    }
  | {
      type: 'post_created';
      postId: string;
      authorId: string;
    };

export interface NotificationDeliveryPayload {
  kind: 'generic' | 'new_message' | 'group_message';
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
  senderId?: string;
  senderName?: string;
  senderImage?: string;
  messageId?: string;
  clientMessageId?: string;
  messageContent?: string;
  contentType?: string;
  mediaUrl?: string;
  mediaType?: string;
  fileName?: string;
  fileSize?: number;
  messageCreatedAt?: string;
  messageUpdatedAt?: string;
  conversationId?: string;
  groupId?: string;
  groupName?: string;
  groupImage?: string;
}

export interface RealtimeFanoutPayload {
  envelopes: RealtimeEnvelope[];
}

export interface ConnectionAcceptedSideEffectsPayload {
  connectionId: string;
  requesterId: string;
  addresseeId: string;
  requester: {
    id: string;
    username: string;
    name: string;
    profileImage: string | null;
    headline: string | null;
    college: string | null;
    isVerified: boolean;
    profileBadgeStyle: string | null;
  };
  addressee: {
    id: string;
    username: string;
    name: string;
    profileImage: string | null;
    headline: string | null;
    college: string | null;
    isVerified: boolean;
    profileBadgeStyle: string | null;
  };
}
