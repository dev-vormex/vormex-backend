import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prismaRead, prisma } from "../../../../config/prisma";
import { assertUsersCanInteract } from "../../../safety/services/trust-safety.service";
import type { RealtimeEnvelope } from "../../../../infrastructure/realtime/channels";
import { shouldNotifySenderAboutReadReceipt } from "../../services/chat-read-receipts.service";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { emitRealtimeEnvelopes } from "../../../../infrastructure/realtime/emitter";
import { AuthRequest, conversationCacheTags, getReadReceiptVisibility, invalidateChatCaches, sendControllerError, blockedPeerIdsForUser } from "./support.controller";

export const markAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const conversationId = ensureString(req.params.conversationId);
    if (!conversationId) {
      res.status(400).json({ error: 'Conversation ID is required' });
      return;
    }
    const availabilityConversation = await prismaRead.conversations.findFirst({
      where: {
        id: conversationId,
        OR: [{ participant1Id: req.user.userId }, { participant2Id: req.user.userId }],
      },
      select: { participant1Id: true, participant2Id: true },
    });
    if (!availabilityConversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const availabilityPeerId = availabilityConversation.participant1Id === req.user.userId
      ? availabilityConversation.participant2Id
      : availabilityConversation.participant1Id;
    await assertUsersCanInteract(req.user.userId, availabilityPeerId, 'read receipt');
    const now = new Date();
    let realtimeEnvelopes: RealtimeEnvelope[] = [];
    let cacheTags: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      const conversation = await tx.conversations.findFirst({
        where: {
          id: conversationId,
          OR: [
            { participant1Id: req.user!.userId },
            { participant2Id: req.user!.userId },
          ],
        },
      });

      if (!conversation) {
        return null;
      }

      const updated = await tx.messages.updateMany({
        where: {
          conversationId,
          receiverId: req.user!.userId,
          status: { not: 'READ' },
        },
        data: {
          status: 'READ',
          readAt: now,
          updatedAt: now,
        },
      });

      const senderId =
        conversation.participant1Id === req.user!.userId
          ? conversation.participant2Id
          : conversation.participant1Id;

      return {
        updatedCount: updated.count,
        senderId,
        participant1Id: conversation.participant1Id,
        participant2Id: conversation.participant2Id,
      };
    });

    if (!result) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    cacheTags = conversationCacheTags(
      conversationId,
      result.participant1Id,
      result.participant2Id
    );

    const senderCanUseReadReceipts = await getReadReceiptVisibility(result.senderId);
    if (shouldNotifySenderAboutReadReceipt({
      updatedCount: result.updatedCount,
      senderCanUseReadReceipts,
    })) {
      const payload = {
        conversationId,
        readBy: req.user!.userId,
        readAt: now.toISOString(),
      };

      realtimeEnvelopes = [
        {
          event: 'chat:messages_read',
          users: [result.senderId],
          payload,
        },
      ];
    }

    const outboxResults = await Promise.allSettled([
      ...(realtimeEnvelopes.length > 0
        ? [
            enqueueRealtimeFanout(prisma as any, {
              aggregateType: 'conversation',
              aggregateId: conversationId,
              eventType: 'chat.messages.read',
              envelopes: realtimeEnvelopes,
            }),
          ]
        : []),
      enqueueCacheInvalidation(prisma as any, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.messages.read.cache.invalidate',
        tags: cacheTags,
      }),
    ]);

    outboxResults.forEach((outboxResult) => {
      if (outboxResult.status === 'rejected') {
        console.error('markAsRead outbox enqueue failed:', outboxResult.reason);
      }
    });

    await invalidateChatCaches(cacheTags);
    emitRealtimeEnvelopes(realtimeEnvelopes);
    res.status(200).json({
      updatedCount: result.updatedCount,
      readAt: now.toISOString(),
    });
  } catch (error) {
    sendControllerError(res, error, 'Failed to mark messages as read');
  }
};

export const getUnreadCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const blockedUserIds = await blockedPeerIdsForUser(req.user.userId);
    const unreadCount = await prismaRead.messages.count({
      where: {
        receiverId: req.user.userId,
        ...(blockedUserIds.length > 0 ? { senderId: { notIn: blockedUserIds } } : {}),
        status: { not: 'READ' },
      },
    });

    res.status(200).json({ unreadCount });
  } catch (error) {
    console.error('getUnreadCount error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
};

export const getMessageLimitStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    await assertUsersCanInteract(req.user.userId, userId, 'message');

    const isConnected = await prismaRead.connections.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: req.user.userId, addresseeId: userId },
          { requesterId: userId, addresseeId: req.user.userId },
        ],
      },
    });

    if (isConnected) {
      res.status(200).json({
        canSend: true,
        isConnected: true,
        messagesSent: 0,
        messagesRemaining: -1,
        limit: -1,
      });
      return;
    }

    const messagesSent = await prismaRead.messages.count({
      where: {
        senderId: req.user.userId,
        receiverId: userId,
      },
    });

    const limit = 2;
    const canSend = messagesSent < limit;

    res.status(200).json({
      canSend,
      isConnected: false,
      messagesSent,
      messagesRemaining: Math.max(0, limit - messagesSent),
      limit,
    });
  } catch (error) {
    sendControllerError(res, error, 'Failed to get message limit status');
  }
};
