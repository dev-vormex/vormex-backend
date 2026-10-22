import { Response } from "express";
import { clampPageSize, decodeKeysetCursor, decodeLegacyDateCursor, nullableDateDescIdAscWhere, encodeKeysetCursor } from "../../../../shared/utils/keyset-pagination.util";
import { prismaRead, prisma } from "../../../../config/prisma";
import { isPrismaConnectionError } from "../../../../shared/utils/prisma-error.util";
import { assertUsersCanInteract, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { randomUUID } from "crypto";
import { AuthRequest, blockedPeerIdsForUser, unavailableConversationIdsForUser, userSelect, getReadReceiptVisibility, getChatPremiumVisibilityByUserIds, buildChatUserIdentity, maskLastMessagePayload, invalidateChatCaches, conversationCacheTags } from "./support.controller";

export const getConversations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = clampPageSize(req.query.limit, 20, 50);
    const cursorValue = req.query.cursor as string | undefined;
    const cursor = decodeKeysetCursor(cursorValue, 'chat.conversations');
    const legacyCursorDate = cursor ? null : decodeLegacyDateCursor(cursorValue);
    const blockedUserIds = await blockedPeerIdsForUser(req.user.userId);
    const unavailableConversationIds = await unavailableConversationIdsForUser(req.user.userId);

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

    const keysetWhere = nullableDateDescIdAscWhere(cursor, 'lastMessageAt');
    if (keysetWhere) {
      whereClause.AND = [keysetWhere];
    } else if (legacyCursorDate) {
      whereClause.lastMessageAt = { lt: legacyCursorDate };
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
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: limit + 1,
    });

    const hasMore = conversations.length > limit;
    const results = hasMore ? conversations.slice(0, -1) : conversations;
    const viewerCanUseReadReceipts = await getReadReceiptVisibility(req.user.userId);
    const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds(
      results.flatMap((conv) => [conv.participant1Id, conv.participant2Id])
    );

    const conversationIds = results.map((conv) => conv.id);
    const unreadCounts = conversationIds.length
      ? await prismaRead.messages.groupBy({
          by: ['conversationId'],
          where: {
            conversationId: { in: conversationIds },
            receiverId: req.user.userId,
            status: { not: 'READ' },
            NOT: { hiddenForUserIds: { has: req.user.userId } },
          },
          _count: { _all: true },
        })
      : [];

    const unreadCountMap = new Map<string, number>(
      unreadCounts.map((item) => [item.conversationId, item._count._all])
    );

    const formatted = await Promise.all(
      results.map(async (conv) => {
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
          conv.participant1Id === req.user!.userId ? participant2 : participant1;
        const unreadCount = unreadCountMap.get(conv.id) || 0;

        return {
          id: conv.id,
          participant1Id: conv.participant1Id,
          participant2Id: conv.participant2Id,
          participant1,
          participant2,
          otherParticipant,
          lastMessage: maskLastMessagePayload(
            convWithRelations.messages[0],
            req.user!.userId,
            viewerCanUseReadReceipts
          ),
          lastMessageAt: conv.lastMessageAt?.toISOString() || null,
          unreadCount,
          createdAt: conv.createdAt.toISOString(),
          updatedAt: conv.updatedAt.toISOString(),
        };
      })
    );

    res.status(200).json({
      conversations: formatted,
      unavailableConversationIds,
      hasMore,
      nextCursor: hasMore && results.length > 0
        ? encodeKeysetCursor({
            scope: 'chat.conversations',
            t: results[results.length - 1].lastMessageAt?.toISOString() || null,
            id: results[results.length - 1].id,
          })
        : undefined,
    });
  } catch (error) {
    console.error('getConversations error:', error);
    if (isPrismaConnectionError(error)) {
      res.status(503).json({ error: 'Database is temporarily unavailable. Please try again in a moment.' });
      return;
    }
    res.status(500).json({ error: 'Failed to get conversations' });
  }
};

export const getOrCreateConversation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { participantId } = req.body;

    if (!participantId) {
      res.status(400).json({ error: 'Participant ID is required' });
      return;
    }

    if (participantId === req.user.userId) {
      res.status(400).json({ error: 'Cannot create conversation with yourself' });
      return;
    }

    const participant = await prisma.user.findUnique({
      where: { id: participantId },
      select: userSelect,
    });

    if (!participant) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await assertUsersCanInteract(req.user.userId, participantId, 'conversation');

    let createdConversation = false;
    let conversation = await prisma.conversations.findFirst({
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
          where: { NOT: { hiddenForUserIds: { has: req.user.userId } } },
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
      createdConversation = true;
      conversation = await prisma.conversations.create({
        data: {
          id: randomUUID(),
          participant1Id: req.user.userId,
          participant2Id: participantId,
          updatedAt: new Date(),
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
    } else if (conversation.hiddenForUserIds.includes(req.user.userId)) {
      await prisma.$executeRaw`
        UPDATE "conversations"
        SET "hiddenForUserIds" = array_remove("hiddenForUserIds", ${req.user.userId}),
            "updatedAt" = NOW()
        WHERE "id" = ${conversation.id}
      `;
    }

    const convWithRelations = conversation as typeof conversation & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown; messages: unknown[] };
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

    if (createdConversation) {
      await invalidateChatCaches(
        conversationCacheTags(
          conversation.id,
          conversation.participant1Id,
          conversation.participant2Id
        )
      );
    }

    res.status(200).json({
      id: conversation.id,
      participant1Id: conversation.participant1Id,
      participant2Id: conversation.participant2Id,
      participant1,
      participant2,
      otherParticipant,
      lastMessage: convWithRelations.messages[0] || null,
      lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
      unreadCount: 0,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('getOrCreateConversation error:', error);
    res.status(500).json({ error: 'Failed to get or create conversation' });
  }
};
