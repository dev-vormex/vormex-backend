import { prisma } from "../../../../config/prisma";
import { enqueueOutboxEvent } from "../../../../infrastructure/outbox/service";
import { queueNames } from "../../../../infrastructure/queue/queue-names";
import { NotificationService } from "./service.service";

export const collapseInboxNotifications = (notifications: any[] = []) => {
  const seenConnectionRequests = new Set<string>();

  return notifications.filter((notification) => {
    if (notification?.type !== 'connection_request' || !notification?.actorId) {
      return true;
    }

    const key = `${notification.type}:${notification.actorId}`;
    if (seenConnectionRequests.has(key)) {
      return false;
    }

    seenConnectionRequests.add(key);
    return true;
  });
};

export async function markAsReadOperation(this: NotificationService, userId: string, notificationIds: string[]): Promise<void> {
    const targetNotifications = await prisma.notifications.findMany({
      where: {
        id: { in: notificationIds },
        userId,
      },
      select: {
        id: true,
        type: true,
        actorId: true,
      },
    });

    const connectionRequestActorIds = Array.from(
      new Set(
        targetNotifications
          .filter((notification) => notification.type === 'connection_request' && notification.actorId)
          .map((notification) => notification.actorId),
      ),
    );

    const orClauses: any[] = [{ id: { in: notificationIds } }];
    if (connectionRequestActorIds.length > 0) {
      orClauses.push({
        type: 'connection_request',
        actorId: { in: connectionRequestActorIds },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.notifications.updateMany({
        where: {
          userId,
          OR: orClauses,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'notification',
        aggregateId: userId,
        eventType: 'notification.read',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`notifications:${userId}`],
        },
      });
    });
  }

export async function markAllAsReadOperation(this: NotificationService, userId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.notifications.updateMany({
        where: {
          userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'notification',
        aggregateId: userId,
        eventType: 'notification.read_all',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [`notifications:${userId}`],
        },
      });
    });
  }
