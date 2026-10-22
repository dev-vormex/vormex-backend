import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { invalidateConversationParticipants } from "../../services/chat-conversation-cache.service";
import { AuthRequest, conversationCacheTags, invalidateChatCaches } from "./support.controller";

export const deleteConversation = async (req: AuthRequest, res: Response): Promise<void> => {
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

    // Verify user is part of the conversation
    const conversation = await prisma.conversations.findFirst({
      where: {
        id: conversationId,
        OR: [
          { participant1Id: req.user.userId },
          { participant2Id: req.user.userId },
        ],
      },
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const cacheTags = conversationCacheTags(
      conversationId,
      conversation.participant1Id,
      conversation.participant2Id
    );

    await prisma.$transaction(async (tx) => {
      await tx.messages.updateMany({
        where: {
          conversationId,
          NOT: { hiddenForUserIds: { has: req.user!.userId } },
        },
        data: { hiddenForUserIds: { push: req.user!.userId }, updatedAt: new Date() },
      });

      await tx.conversations.updateMany({
        where: {
          id: conversationId,
          NOT: { hiddenForUserIds: { has: req.user!.userId } },
        },
        data: { hiddenForUserIds: { push: req.user!.userId }, updatedAt: new Date() },
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.conversation.deleted.cache.invalidate',
        tags: cacheTags,
      });
    });

    await invalidateChatCaches(cacheTags);
    invalidateConversationParticipants(conversationId);
    console.log(`Hid conversation ${conversationId} for user ${req.user.userId}`);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('deleteConversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
};
