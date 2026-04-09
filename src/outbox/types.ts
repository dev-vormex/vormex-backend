import type { QueueName } from '../infrastructure/queue/queue-names';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  queueName: QueueName;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

export interface CacheInvalidationPayload {
  tags: string[];
}

export interface NotificationDeliveryPayload {
  kind: 'generic' | 'new_message';
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
  senderId?: string;
  senderName?: string;
  senderImage?: string;
  conversationId?: string;
}

export interface RealtimeFanoutPayload {
  envelopes: RealtimeEnvelope[];
}
