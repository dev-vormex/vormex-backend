import { prisma } from "../../../../config/prisma";
import { NotificationService } from "./service.service";

export async function notifyConnectionRequestOperation(this: NotificationService, userId: string, requesterId: string, requesterName: string): Promise<void> {
    await this.deleteConnectionRequestNotifications(userId, requesterId);

    await this.createNotification({
      userId,
      type: 'connection_request',
      title: '🤝 Connection Request',
      body: `${requesterName} wants to connect with you`,
      actorId: requesterId,
    });
  }

export async function deleteConnectionRequestNotificationsOperation(this: NotificationService, userId: string, actorId: string): Promise<void> {
    await prisma.notifications.deleteMany({
      where: {
        userId,
        type: 'connection_request',
        actorId,
      },
    });
  }

export async function notifyConnectionAcceptedOperation(this: NotificationService, userId: string, accepterId: string, accepterName: string): Promise<void> {
    await this.createNotification({
      userId,
      type: 'connection_accepted',
      title: '✅ Connection Accepted',
      body: `${accepterName} accepted your connection request`,
      actorId: accepterId,
    });
  }
