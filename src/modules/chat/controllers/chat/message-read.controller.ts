import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { decodeKeysetCursor, dateAscKeysetWhere, clampPageSize, decodeLegacyDateCursor, createdAtDescKeysetWhere, encodeKeysetCursor } from "../../../../shared/utils/keyset-pagination.util";
import { prismaRead } from "../../../../config/prisma";
import { maskReadReceiptForViewer } from "../../services/chat-read-receipts.service";
import { AuthRequest, blockedPeerIdsForUser, unavailableConversationIdsForUser, encodeChatSyncState, CHAT_SYNC_SCOPE, parseChatSyncState, CHAT_SYNC_PAGE_SIZE, userSelect, getReadReceiptVisibility, getChatUserLookup, mapMessagePayload, getChatPremiumVisibilityByUserIds, buildChatUserIdentity, maskLastMessagePayload, ChatSyncCursorState, assertConversationReadAvailable, sendControllerError } from "./support.controller";

export const syncChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const blockedUserIds = await blockedPeerIdsForUser(userId);
    const unavailableConversationIds = await unavailableConversationIdsForUser(userId);

    const sinceValue = ensureString(req.query.since);
    if (!sinceValue) {
      const now = new Date().toISOString();
      res.status(200).json({
        messages: [],
        statusChanges: [],
        conversations: [],
        unavailableConversationIds,
        cursor: encodeChatSyncState({
          messages: { t: now, id: '' },
          conversations: { t: now, id: '' },
        }),
        hasMore: false,
      });
      return;
    }

    const decodedCursor = decodeKeysetCursor(sinceValue, CHAT_SYNC_SCOPE);
    const syncState = parseChatSyncState(decodedCursor);
    if (!syncState) {
      res.status(400).json({ error: 'Invalid chat sync cursor' });
      return;
    }

    const messageCursorWhere = dateAscKeysetWhere(
      { ...syncState.messages, scope: CHAT_SYNC_SCOPE },
      'updatedAt'
    );
    const conversationCursorWhere = dateAscKeysetWhere(
      { ...syncState.conversations, scope: CHAT_SYNC_SCOPE },
      'updatedAt'
    );

    const [changedMessages, changedConversations] = await Promise.all([
      prismaRead.messages.findMany({
        where: {
          AND: [
            {
              OR: [
                {
                  senderId: userId,
                  ...(blockedUserIds.length > 0 ? { receiverId: { notIn: blockedUserIds } } : {}),
                },
                {
                  receiverId: userId,
                  ...(blockedUserIds.length > 0 ? { senderId: { notIn: blockedUserIds } } : {}),
                },
              ],
            },
            { NOT: { hiddenForUserIds: { has: userId } } },
            ...(messageCursorWhere ? [messageCursorWhere] : []),
          ],
        },
        include: {
          message_reactions: true,
          messages: {
            select: { id: true, content: true, contentType: true, senderId: true },
          },
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: CHAT_SYNC_PAGE_SIZE + 1,
      }),
      prismaRead.conversations.findMany({
        where: {
          AND: [
            {
              OR: [
                {
                  participant1Id: userId,
                  ...(blockedUserIds.length > 0 ? { participant2Id: { notIn: blockedUserIds } } : {}),
                },
                {
                  participant2Id: userId,
                  ...(blockedUserIds.length > 0 ? { participant1Id: { notIn: blockedUserIds } } : {}),
                },
              ],
            },
            { NOT: { hiddenForUserIds: { has: userId } } },
            ...(conversationCursorWhere ? [conversationCursorWhere] : []),
          ],
        },
        include: {
          users_conversations_participant1IdTousers: { select: userSelect },
          users_conversations_participant2IdTousers: { select: userSelect },
          messages: {
            where: { NOT: { hiddenForUserIds: { has: userId } } },
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
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: CHAT_SYNC_PAGE_SIZE + 1,
      }),
    ]);

    type SyncMarker = {
      kind: 'message' | 'conversation';
      id: string;
      updatedAt: Date;
      row: any;
    };
    const markers: SyncMarker[] = [
      ...changedMessages.map((row) => ({ kind: 'message' as const, id: row.id, updatedAt: row.updatedAt, row })),
      ...changedConversations.map((row) => ({ kind: 'conversation' as const, id: row.id, updatedAt: row.updatedAt, row })),
    ].sort((left, right) =>
      left.updatedAt.getTime() - right.updatedAt.getTime() ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
    );

    const selectedMarkers = markers.slice(0, CHAT_SYNC_PAGE_SIZE);
    const selectedMessageRows = selectedMarkers
      .filter((marker) => marker.kind === 'message')
      .map((marker) => marker.row);
    const selectedConversationRows = selectedMarkers
      .filter((marker) => marker.kind === 'conversation')
      .map((marker) => marker.row);
    const viewerCanUseReadReceipts = await getReadReceiptVisibility(userId);
    const senderLookup = await getChatUserLookup(
      selectedMessageRows.map((message) => message.senderId)
    );
    const formattedChangedMessages = selectedMessageRows.map((message) =>
      mapMessagePayload(
        message,
        senderLookup.get(message.senderId),
        message.message_reactions,
        { viewerUserId: userId, viewerCanUseReadReceipts }
      )
    );
    const previousMessageTimestamp = Date.parse(syncState.messages.t);
    const newMessages = formattedChangedMessages.filter(
      (message) => Date.parse(message.createdAt) >= previousMessageTimestamp
    );
    const newMessageIds = new Set(newMessages.map((message) => message.id));
    const statusChanges = formattedChangedMessages.filter((message) => !newMessageIds.has(message.id));

    const conversationIds = selectedConversationRows.map((conversation) => conversation.id);
    const unreadCounts = conversationIds.length
      ? await prismaRead.messages.groupBy({
          by: ['conversationId'],
          where: {
            conversationId: { in: conversationIds },
            receiverId: userId,
            status: { not: 'READ' },
          },
          _count: { _all: true },
        })
      : [];
    const unreadCountMap = new Map(
      unreadCounts.map((item) => [item.conversationId, item._count._all])
    );
    const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds(
      selectedConversationRows.flatMap((conversation) => [conversation.participant1Id, conversation.participant2Id])
    );
    const formattedConversations = selectedConversationRows.map((conversation) => {
      const participant1 = buildChatUserIdentity(
        conversation.users_conversations_participant1IdTousers,
        premiumVisibilityByUser
      );
      const participant2 = buildChatUserIdentity(
        conversation.users_conversations_participant2IdTousers,
        premiumVisibilityByUser
      );
      return {
        id: conversation.id,
        participant1Id: conversation.participant1Id,
        participant2Id: conversation.participant2Id,
        participant1,
        participant2,
        otherParticipant: conversation.participant1Id === userId ? participant2 : participant1,
        lastMessage: maskLastMessagePayload(
          conversation.messages[0],
          userId,
          viewerCanUseReadReceipts
        ),
        lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
        unreadCount: unreadCountMap.get(conversation.id) || 0,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      };
    });

    const nextState: ChatSyncCursorState = {
      messages: { ...syncState.messages },
      conversations: { ...syncState.conversations },
    };
    selectedMarkers.forEach((marker) => {
      const source = marker.kind === 'message' ? 'messages' : 'conversations';
      nextState[source] = { t: marker.updatedAt.toISOString(), id: marker.id };
    });
    const hasMore = markers.length > CHAT_SYNC_PAGE_SIZE ||
      changedMessages.length > CHAT_SYNC_PAGE_SIZE ||
      changedConversations.length > CHAT_SYNC_PAGE_SIZE;

    res.status(200).json({
      messages: newMessages,
      statusChanges,
      conversations: formattedConversations,
      unavailableConversationIds,
      cursor: encodeChatSyncState(nextState),
      hasMore,
    });
  } catch (error) {
    console.error('syncChat error:', error);
    res.status(500).json({ error: 'Failed to synchronize chat changes' });
  }
};

export const getMessages = async (req: AuthRequest, res: Response): Promise<void> => {
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
    const limit = clampPageSize(req.query.limit, 50, 50);
    const cursorValue = ensureString(req.query.cursor);
    const cursor = decodeKeysetCursor(cursorValue, `chat.messages:${conversationId}`);
    const legacyCursorDate = cursor ? null : decodeLegacyDateCursor(cursorValue);

    const conversation = await prismaRead.conversations.findFirst({
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

    await assertConversationReadAvailable(conversation, req.user.userId);

    const whereClause: any = {
      conversationId,
      NOT: { hiddenForUserIds: { has: req.user.userId } },
    };
    const cursorWhere = createdAtDescKeysetWhere(cursor);
    if (cursorWhere) {
      whereClause.AND = [cursorWhere];
    } else if (legacyCursorDate) {
      whereClause.createdAt = { lt: legacyCursorDate };
    }

    const messages = await prismaRead.messages.findMany({
      where: whereClause,
      include: {
        message_reactions: true,
        messages: {
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const results = hasMore ? messages.slice(0, -1) : messages;

    const senderLookup = await getChatUserLookup(results.map((message) => message.senderId));
    const viewerCanUseReadReceipts = await getReadReceiptVisibility(req.user.userId);

    const formatted = results.map((msg) =>
      mapMessagePayload(
        msg,
        senderLookup.get(msg.senderId),
        (msg as typeof msg & { message_reactions: { id: string; userId: string; emoji: string }[] }).message_reactions,
        {
          viewerUserId: req.user!.userId,
          viewerCanUseReadReceipts,
        }
      )
    );

    res.status(200).json({
      messages: formatted.reverse(),
      hasMore,
      nextCursor: hasMore && results.length > 0
        ? encodeKeysetCursor({
            scope: `chat.messages:${conversationId}`,
            t: results[results.length - 1].createdAt.toISOString(),
            id: results[results.length - 1].id,
          })
        : undefined,
    });
  } catch (error) {
    sendControllerError(res, error, 'Failed to get messages');
  }
};

export const searchMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const query = (ensureString(req.query.q) || '').trim().slice(0, 120);
    const limit = clampPageSize(req.query.limit, 20, 50);

    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const blockedUserIds = await blockedPeerIdsForUser(req.user.userId);
    const conversations = await prismaRead.conversations.findMany({
      where: {
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
      select: { id: true },
    });

    const conversationIds = conversations.map((c) => c.id);

    const messages = await prismaRead.messages.findMany({
      where: {
        conversationId: { in: conversationIds },
        content: { contains: query, mode: 'insensitive' },
        isDeleted: false,
        NOT: { hiddenForUserIds: { has: req.user.userId } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const viewerCanUseReadReceipts = await getReadReceiptVisibility(req.user.userId);
    res.status(200).json({
      messages: messages.map((message) =>
        maskReadReceiptForViewer(message, req.user!.userId, viewerCanUseReadReceipts)
      ),
    });
  } catch (error) {
    console.error('searchMessages error:', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
};
