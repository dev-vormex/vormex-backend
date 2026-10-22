import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { assertUsersCanInteract, SafetyActionError, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { prismaRead } from "../../../../config/prisma";
import { isPrismaConnectionError } from "../../../../shared/utils/prisma-error.util";
import { AuthRequest, userSelect, getChatPremiumVisibilityByUserIds, buildChatUserIdentity, getReadReceiptVisibility, maskLastMessagePayload, assertConversationReadAvailable, sendControllerError } from "./support.controller";

export const getConversationStatusWithUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const participantId = ensureString(req.params.userId);

    if (!participantId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    if (participantId === req.user.userId) {
      res.status(400).json({ error: 'Cannot check conversation with yourself' });
      return;
    }

    try {
      await assertUsersCanInteract(req.user.userId, participantId, 'conversation');
    } catch (error) {
      if (error instanceof SafetyActionError && error.code === 'user_blocked') {
        throw new SafetyActionError('This resource is unavailable.', 'resource_unavailable', 404, undefined, false);
      }
      throw error;
    }

    const participant = await prismaRead.user.findUnique({
      where: { id: participantId },
      select: userSelect,
    });

    if (!participant) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const conversation = await prismaRead.conversations.findFirst({
      where: {
        OR: [
          { participant1Id: req.user.userId, participant2Id: participantId },
          { participant1Id: participantId, participant2Id: req.user.userId },
        ],
      },
      include: {
        users_conversations_participant1IdTousers: { select: userSelect },
        users_conversations_participant2IdTousers: { select: userSelect },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    if (!conversation) {
      res.status(200).json({
        hasConversation: false,
        hasMessages: false,
        conversation: null,
      });
      return;
    }

    const convWithRelations = conversation as typeof conversation & {
      users_conversations_participant1IdTousers: unknown;
      users_conversations_participant2IdTousers: unknown;
      messages: unknown[];
    };
    const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds([
      conversation.participant1Id,
      conversation.participant2Id,
    ]);
    const participant1 = buildChatUserIdentity(
      convWithRelations.users_conversations_participant1IdTousers as { id?: string | null; profileBadgeStyle?: string | null },
      premiumVisibilityByUser
    );
    const participant2 = buildChatUserIdentity(
      convWithRelations.users_conversations_participant2IdTousers as { id?: string | null; profileBadgeStyle?: string | null },
      premiumVisibilityByUser
    );
    const otherParticipant =
      conversation.participant1Id === req.user.userId
        ? participant2
        : participant1;

    const unreadCount = await prismaRead.messages.count({
      where: {
        conversationId: conversation.id,
        receiverId: req.user.userId,
        status: { not: 'READ' },
      },
    });
    const lastMessage = convWithRelations.messages[0] || null;
    const viewerCanUseReadReceipts = await getReadReceiptVisibility(req.user.userId);

    res.status(200).json({
      hasConversation: true,
      hasMessages: Boolean(lastMessage),
      conversation: {
        id: conversation.id,
        participant1Id: conversation.participant1Id,
        participant2Id: conversation.participant2Id,
        participant1,
        participant2,
        otherParticipant,
        lastMessage: maskLastMessagePayload(
          lastMessage,
          req.user.userId,
          viewerCanUseReadReceipts
        ),
        lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
        unreadCount,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('getConversationStatusWithUser error:', error);
    if (isPrismaConnectionError(error)) {
      res.status(503).json({ error: 'Database is temporarily unavailable. Please try again in a moment.' });
      return;
    }
    res.status(500).json({ error: 'Failed to get conversation status' });
  }
};

export const getConversation = async (req: AuthRequest, res: Response): Promise<void> => {
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

    const conversation = await prismaRead.conversations.findFirst({
      where: {
        id: conversationId,
        OR: [
          { participant1Id: req.user.userId },
          { participant2Id: req.user.userId },
        ],
      },
      include: {
        users_conversations_participant1IdTousers: { select: userSelect },
        users_conversations_participant2IdTousers: { select: userSelect },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    await assertConversationReadAvailable(conversation, req.user.userId);

    const convWithRelations = conversation as typeof conversation & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown; messages: unknown[] };
    const viewerCanUseReadReceipts = await getReadReceiptVisibility(req.user.userId);
    const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds([
      conversation.participant1Id,
      conversation.participant2Id,
    ]);
    const participant1 = buildChatUserIdentity(
      convWithRelations.users_conversations_participant1IdTousers as { id?: string | null; profileBadgeStyle?: string | null },
      premiumVisibilityByUser
    );
    const participant2 = buildChatUserIdentity(
      convWithRelations.users_conversations_participant2IdTousers as { id?: string | null; profileBadgeStyle?: string | null },
      premiumVisibilityByUser
    );
    const otherParticipant =
      conversation.participant1Id === req.user.userId
        ? participant2
        : participant1;

    const unreadCount = await prismaRead.messages.count({
      where: {
        conversationId: conversation.id,
        receiverId: req.user.userId,
        status: { not: 'READ' },
      },
    });

    res.status(200).json({
      id: conversation.id,
      participant1Id: conversation.participant1Id,
      participant2Id: conversation.participant2Id,
      participant1,
      participant2,
      otherParticipant,
      lastMessage: maskLastMessagePayload(
        convWithRelations.messages[0],
        req.user.userId,
        viewerCanUseReadReceipts
      ),
      lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
      unreadCount,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    });
  } catch (error) {
    sendControllerError(res, error, 'Failed to get conversation');
  }
};
