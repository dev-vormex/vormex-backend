import { Response } from "express";
import { clampPageSize } from "../../../../shared/utils/keyset-pagination.util";
import { prismaRead, prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { assertUsersCanInteract } from "../../../safety/services/trust-safety.service";
import { enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { AuthRequest, blockedPeerIdsForUser, userSelect, getChatPremiumVisibilityByUserIds, buildChatUserIdentity, sendControllerError, conversationCacheTags, invalidateChatCaches } from "./support.controller";

export const getMessageRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = clampPageSize(req.query.limit, 20, 50);
    const cursor = req.query.cursor as string | undefined;
    const blockedUserIds = await blockedPeerIdsForUser(req.user.userId);

    const myConnectionIds = await prismaRead.connections.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: req.user.userId },
          { addresseeId: req.user.userId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const connectedUserIds = new Set(
      myConnectionIds.flatMap((c) => [c.requesterId, c.addresseeId])
    );
    connectedUserIds.delete(req.user.userId);

    const whereClause: any = {
      NOT: { hiddenForUserIds: { has: req.user.userId } },
      OR: [
        {
          participant1Id: req.user.userId,
          ...(blockedUserIds.length > 0 ? { participant2Id: { notIn: blockedUserIds } } : {}),
        },
        {
          participant2Id: req.user.userId,
          ...(blockedUserIds.length > 0 ? { participant1Id: { notIn: blockedUserIds } } : {}),
        },
      ],
    };

    if (cursor) {
      whereClause.lastMessageAt = { lt: new Date(cursor) };
    }

    const conversations = await prismaRead.conversations.findMany({
      where: whereClause,
      include: {
        users_conversations_participant1IdTousers: { select: userSelect },
        users_conversations_participant2IdTousers: { select: userSelect },
        messages: {
          where: { NOT: { hiddenForUserIds: { has: req.user.userId } } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: limit + 1,
    });

    const messageRequests = conversations.filter((conv) => {
      const otherId =
        conv.participant1Id === req.user!.userId
          ? conv.participant2Id
          : conv.participant1Id;
      return !connectedUserIds.has(otherId);
    });

    const hasMore = messageRequests.length > limit;
    const results = hasMore ? messageRequests.slice(0, -1) : messageRequests;
    const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds(
      results.flatMap((conv) => [conv.participant1Id, conv.participant2Id])
    );

    const formatted = results.map((conv) => {
      const convWithRelations = conv as typeof conv & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown; messages: unknown[] };
      const participant1 = buildChatUserIdentity(
        convWithRelations.users_conversations_participant1IdTousers as { id?: string | null; profileBadgeStyle?: string | null },
        premiumVisibilityByUser
      );
      const participant2 = buildChatUserIdentity(
        convWithRelations.users_conversations_participant2IdTousers as { id?: string | null; profileBadgeStyle?: string | null },
        premiumVisibilityByUser
      );
      const otherParticipant =
        conv.participant1Id === req.user!.userId
          ? participant2
          : participant1;

      return {
        id: conv.id,
        participant1Id: conv.participant1Id,
        participant2Id: conv.participant2Id,
        participant1,
        participant2,
        otherParticipant,
        lastMessage: convWithRelations.messages[0] || null,
        lastMessageAt: conv.lastMessageAt?.toISOString() || null,
        unreadCount: 0,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
        isMessageRequest: true,
        messageRequestAcceptedAt: null,
      };
    });

    res.status(200).json({
      messageRequests: formatted,
      hasMore,
      nextCursor: hasMore && results.length > 0
        ? results[results.length - 1].lastMessageAt?.toISOString()
        : undefined,
    });
  } catch (error) {
    console.error('getMessageRequests error:', error);
    res.status(500).json({ error: 'Failed to get message requests' });
  }
};

export const getMessageRequestsCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const myConnectionIds = await prismaRead.connections.findMany({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: req.user.userId },
          { addresseeId: req.user.userId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const connectedUserIds = new Set(
      myConnectionIds.flatMap((c) => [c.requesterId, c.addresseeId])
    );
    connectedUserIds.delete(req.user.userId);
    const blockedUserIds = await blockedPeerIdsForUser(req.user.userId);

    const conversations = await prismaRead.conversations.findMany({
      where: {
        NOT: { hiddenForUserIds: { has: req.user.userId } },
        OR: [
          {
            participant1Id: req.user.userId,
            ...(blockedUserIds.length > 0 ? { participant2Id: { notIn: blockedUserIds } } : {}),
          },
          {
            participant2Id: req.user.userId,
            ...(blockedUserIds.length > 0 ? { participant1Id: { notIn: blockedUserIds } } : {}),
          },
        ],
      },
      select: { participant1Id: true, participant2Id: true },
    });

    const requestCount = conversations.filter((conv) => {
      const otherId =
        conv.participant1Id === req.user!.userId
          ? conv.participant2Id
          : conv.participant1Id;
      return !connectedUserIds.has(otherId);
    }).length;

    res.status(200).json({ count: requestCount });
  } catch (error) {
    console.error('getMessageRequestsCount error:', error);
    res.status(500).json({ error: 'Failed to get message requests count' });
  }
};

export const acceptMessageRequest = async (req: AuthRequest, res: Response): Promise<void> => {
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
      },
    });

    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const requestPeerId = conversation.participant1Id === req.user.userId
      ? conversation.participant2Id
      : conversation.participant1Id;
    await assertUsersCanInteract(req.user.userId, requestPeerId, 'message request');

    const convWithRelations = conversation as typeof conversation & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown };
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

    res.status(200).json({
      message: 'Message request accepted',
      conversation: {
        id: conversation.id,
        participant1Id: conversation.participant1Id,
        participant2Id: conversation.participant2Id,
        participant1,
        participant2,
        otherParticipant,
        lastMessage: null,
        lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
        unreadCount: 0,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    sendControllerError(res, error, 'Failed to accept message request');
  }
};

export const declineMessageRequest = async (req: AuthRequest, res: Response): Promise<void> => {
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
      await tx.messages.deleteMany({
        where: { conversationId },
      });

      await tx.conversations.delete({
        where: { id: conversationId },
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.message_request.declined.cache.invalidate',
        tags: cacheTags,
      });
    });

    await invalidateChatCaches(cacheTags);
    res.status(200).json({ message: 'Message request declined' });
  } catch (error) {
    console.error('declineMessageRequest error:', error);
    res.status(500).json({ error: 'Failed to decline message request' });
  }
};
