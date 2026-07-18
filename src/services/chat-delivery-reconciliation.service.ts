import { prisma } from '../config/prisma';
import { queueNames } from '../infrastructure/queue/queue-names';
import { getQueue } from '../infrastructure/queue/queues';

export const CHAT_DELIVERY_RECONCILIATION_BATCH_SIZE = 500;
export const CHAT_DELIVERY_RECONCILIATION_JOB = 'chat_delivery_reconcile';

export interface ChatDeliveryGroup {
  conversationId: string;
  senderId: string;
}

export interface ChatDeliveryReconciliationResult {
  deliveredAt: Date;
  groups: ChatDeliveryGroup[];
  hasMore: boolean;
}

export async function reconcilePendingMessageDeliveries(
  userId: string
): Promise<ChatDeliveryReconciliationResult> {
  const pending = await prisma.messages.findMany({
    where: { receiverId: userId, status: 'SENT', isDeleted: false },
    select: { id: true, conversationId: true, senderId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: CHAT_DELIVERY_RECONCILIATION_BATCH_SIZE + 1,
  });
  const batch = pending.slice(0, CHAT_DELIVERY_RECONCILIATION_BATCH_SIZE);
  const deliveredAt = new Date();

  if (batch.length > 0) {
    await prisma.messages.updateMany({
      where: {
        id: { in: batch.map((message) => message.id) },
        receiverId: userId,
        status: 'SENT',
        isDeleted: false,
      },
      data: { status: 'DELIVERED', deliveredAt, updatedAt: deliveredAt },
    });
  }

  const groupsByKey = new Map<string, ChatDeliveryGroup>();
  batch.forEach((message) => {
    groupsByKey.set(`${message.conversationId}:${message.senderId}`, {
      conversationId: message.conversationId,
      senderId: message.senderId,
    });
  });

  return {
    deliveredAt,
    groups: [...groupsByKey.values()],
    hasMore: pending.length > CHAT_DELIVERY_RECONCILIATION_BATCH_SIZE,
  };
}

export async function enqueuePendingDeliveryReconciliation(userId: string): Promise<void> {
  await getQueue(queueNames.maintenance).add(
    CHAT_DELIVERY_RECONCILIATION_JOB,
    { userId },
    {
      // Concurrent reconnects are safe because the database update is
      // conditional on SENT; unique IDs simply reduce redundant queued work.
      jobId: `chat-delivery-${userId}-${Date.now()}`,
    }
  );
}
