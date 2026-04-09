import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma, prismaRead } from '../config/prisma';
import { queueNames } from '../infrastructure/queue/queue-names';
import { enqueueOutboxEvent } from '../outbox/service';
import { enqueueCacheInvalidation, enqueueRealtimeFanout } from '../outbox/helpers';
import { ensureString } from '../utils/request.util';
import { isPrismaConnectionError } from '../utils/prisma-error.util';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const userSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isOnline: true,
  lastActiveAt: true,
};

const buildFallbackChatUser = (userId: string) => ({
  id: userId,
  username: '',
  name: '',
  profileImage: null,
  isOnline: false,
  lastActiveAt: null,
});

const mapMessagePayload = (
  message: any,
  sender: any,
  reactions: { id: string; userId: string; emoji: string }[] = []
) => ({
  id: message.id,
  conversationId: message.conversationId,
  senderId: message.senderId,
  receiverId: message.receiverId,
  content: message.content,
  contentType: message.contentType,
  mediaUrl: message.mediaUrl,
  mediaType: message.mediaType,
  fileName: message.fileName,
  fileSize: message.fileSize,
  status: message.status,
  deliveredAt: message.deliveredAt?.toISOString(),
  readAt: message.readAt?.toISOString(),
  isDeleted: message.isDeleted,
  replyToId: message.replyToId,
  replyTo: (message as typeof message & { messages: unknown }).messages,
  sender: sender || buildFallbackChatUser(message.senderId),
  reactions: reactions.map((reaction) => ({
    id: reaction.id,
    userId: reaction.userId,
    emoji: reaction.emoji,
    user: { id: reaction.userId, username: '', name: '' },
  })),
  createdAt: message.createdAt.toISOString(),
  updatedAt: message.updatedAt.toISOString(),
});

const getChatUserLookup = async (userIds: string[]): Promise<Map<string, any>> => {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueUserIds.length === 0) {
    return new Map();
  }

  const users = await prismaRead.user.findMany({
    where: { id: { in: uniqueUserIds } },
    select: userSelect,
  });

  return new Map(users.map((user) => [user.id, user]));
};

export const getConversations = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const cursor = req.query.cursor as string | undefined;

    const whereClause: any = {
      OR: [
        { participant1Id: req.user.userId },
        { participant2Id: req.user.userId },
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
      orderBy: { lastMessageAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = conversations.length > limit;
    const results = hasMore ? conversations.slice(0, -1) : conversations;

    const conversationIds = results.map((conv) => conv.id);
    const unreadCounts = conversationIds.length
      ? await prismaRead.messages.groupBy({
          by: ['conversationId'],
          where: {
            conversationId: { in: conversationIds },
            receiverId: req.user.userId,
            status: { not: 'READ' },
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
        const otherParticipant =
          conv.participant1Id === req.user!.userId ? convWithRelations.users_conversations_participant2IdTousers : convWithRelations.users_conversations_participant1IdTousers;
        const unreadCount = unreadCountMap.get(conv.id) || 0;

        return {
          id: conv.id,
          participant1Id: conv.participant1Id,
          participant2Id: conv.participant2Id,
          participant1: convWithRelations.users_conversations_participant1IdTousers,
          participant2: convWithRelations.users_conversations_participant2IdTousers,
          otherParticipant,
          lastMessage: convWithRelations.messages[0] || null,
          lastMessageAt: conv.lastMessageAt?.toISOString() || null,
          unreadCount,
          createdAt: conv.createdAt.toISOString(),
          updatedAt: conv.updatedAt.toISOString(),
        };
      })
    );

    res.status(200).json({
      conversations: formatted,
      hasMore,
      nextCursor: hasMore && results.length > 0
        ? results[results.length - 1].lastMessageAt?.toISOString()
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
    }

    const convWithRelations = conversation as typeof conversation & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown; messages: unknown[] };
    const otherParticipant =
      conversation.participant1Id === req.user.userId
        ? convWithRelations.users_conversations_participant2IdTousers
        : convWithRelations.users_conversations_participant1IdTousers;

    res.status(200).json({
      id: conversation.id,
      participant1Id: conversation.participant1Id,
      participant2Id: conversation.participant2Id,
      participant1: convWithRelations.users_conversations_participant1IdTousers,
      participant2: convWithRelations.users_conversations_participant2IdTousers,
      otherParticipant,
      lastMessage: convWithRelations.messages[0] || null,
      lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
      unreadCount: 0,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error('getOrCreateConversation error:', error);
    res.status(500).json({ error: 'Failed to get or create conversation' });
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

    const convWithRelations = conversation as typeof conversation & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown; messages: unknown[] };
    const otherParticipant =
      conversation.participant1Id === req.user.userId
        ? convWithRelations.users_conversations_participant2IdTousers
        : convWithRelations.users_conversations_participant1IdTousers;

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
      participant1: convWithRelations.users_conversations_participant1IdTousers,
      participant2: convWithRelations.users_conversations_participant2IdTousers,
      otherParticipant,
      lastMessage: convWithRelations.messages[0] || null,
      lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
      unreadCount,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error('getConversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
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
    const limit = parseInt(ensureString(req.query.limit) || '50') || 50;
    const cursor = ensureString(req.query.cursor);

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

    const whereClause: any = { conversationId };
    if (cursor) {
      whereClause.createdAt = { lt: new Date(cursor) };
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
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const results = hasMore ? messages.slice(0, -1) : messages;

    const senderLookup = await getChatUserLookup(results.map((message) => message.senderId));

    const formatted = results.map((msg) =>
      mapMessagePayload(
        msg,
        senderLookup.get(msg.senderId),
        (msg as typeof msg & { message_reactions: { id: string; userId: string; emoji: string }[] }).message_reactions
      )
    );

    res.status(200).json({
      messages: formatted.reverse(),
      hasMore,
      nextCursor: hasMore && results.length > 0
        ? results[results.length - 1].createdAt.toISOString()
        : undefined,
    });
  } catch (error) {
    console.error('getMessages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
};

export const sendMessage = async (req: AuthRequest, res: Response): Promise<void> => {
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
    const { content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId } = req.body;

    if (!content && !mediaUrl) {
      res.status(400).json({ error: 'Content or media is required' });
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

    const receiverId =
      conversation.participant1Id === req.user.userId
        ? conversation.participant2Id
        : conversation.participant1Id;

    const sender = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: userSelect,
    });

    const replyToMessage = replyToId
      ? await prisma.messages.findFirst({
          where: {
            id: replyToId,
            conversationId,
          },
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
          },
        })
      : null;

    if (replyToId && !replyToMessage) {
      res.status(400).json({ error: 'Reply target is invalid for this conversation' });
      return;
    }

    const now = new Date();
    const messageId = randomUUID();
    const normalizedContent = content || '';
    const normalizedContentType = contentType || 'text';
    const normalizedFileSize =
      typeof fileSize === 'number' ? fileSize : fileSize ? Number(fileSize) : null;
    const preview = normalizedContent
      ? normalizedContent.length > 100
        ? normalizedContent.substring(0, 97) + '...'
        : normalizedContent
      : 'Sent you a message';

    const messagePayload = mapMessagePayload(
      {
        id: messageId,
        conversationId,
        senderId: req.user.userId,
        receiverId,
        content: normalizedContent,
        contentType: normalizedContentType,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        fileName: fileName || null,
        fileSize: normalizedFileSize,
        status: 'SENT',
        deliveredAt: null,
        readAt: null,
        isDeleted: false,
        replyToId: replyToId || null,
        messages: replyToMessage,
        createdAt: now,
        updatedAt: now,
      },
      sender,
      []
    );

    await prisma.$transaction(async (tx) => {
      await tx.messages.create({
        data: {
          id: messageId,
          conversationId,
          senderId: req.user.userId,
          receiverId,
          content: normalizedContent,
          contentType: normalizedContentType,
          mediaUrl,
          mediaType,
          fileName,
          fileSize: normalizedFileSize,
          replyToId,
          status: 'SENT',
          createdAt: now,
          updatedAt: now,
        },
      });

      await tx.conversations.update({
        where: { id: conversationId },
        data: { lastMessageAt: now, updatedAt: now },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.created',
        queueName: queueNames.realtimeFanout,
        payload: {
          envelopes: [
            {
              event: 'chat:new_message',
              rooms: [`chat:${conversationId}`],
              payload: {
                conversationId,
                message: messagePayload,
              },
            },
            {
              event: 'chat:new_message',
              users: [String(req.user!.userId)],
              payload: {
                conversationId,
                message: messagePayload,
              },
            },
            {
              event: 'chat:notification',
              users: [receiverId],
              payload: {
                type: 'new_message',
                conversationId,
                message: messagePayload,
                sender,
              },
            },
          ],
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.push',
        queueName: queueNames.notificationDelivery,
        payload: {
          kind: 'new_message',
          userId: receiverId,
          title: sender?.name || sender?.username || 'Someone',
          body: preview,
          conversationId,
          senderId: String(req.user!.userId),
          senderName: sender?.name || sender?.username || 'Someone',
          senderImage: sender?.profileImage || undefined,
        },
      });

      await enqueueOutboxEvent(tx as any, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.cache.invalidate',
        queueName: queueNames.cacheInvalidation,
        payload: {
          tags: [
            `conversation:${conversationId}`,
            `notifications:${receiverId}`,
            `notifications:${String(req.user!.userId)}`,
          ],
        },
      });

    }, {
      maxWait: 15_000,
      timeout: 15_000,
    });

    res.status(201).json(messagePayload);
  } catch (error) {
    console.error('sendMessage error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};

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
    const now = new Date();
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

      const payload = {
        conversationId,
        readBy: req.user!.userId,
        readAt: now,
      };

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.messages.read',
        envelopes: [
          {
            event: 'chat:messages_read',
            rooms: [`chat:${conversationId}`],
            payload,
          },
          {
            event: 'chat:messages_read',
            users: [senderId],
            payload,
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'chat.messages.read.cache.invalidate',
        tags: [
          `conversation:${conversationId}`,
          `notifications:${senderId}`,
          `notifications:${String(req.user!.userId)}`,
        ],
      });

      return {
        updatedCount: updated.count,
      };
    });

    if (!result) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.status(200).json({
      updatedCount: result.updatedCount,
      readAt: now.toISOString(),
    });
  } catch (error) {
    console.error('markAsRead error:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
};

export const deleteMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const messageId = ensureString(req.params.messageId);
    if (!messageId) {
      res.status(400).json({ error: 'Message ID is required' });
      return;
    }
    const { forEveryone } = req.body;

    const message = await prisma.messages.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    if (message.senderId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to delete this message' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (forEveryone) {
        await tx.messages.update({
          where: { id: messageId },
          data: { isDeleted: true, content: '', updatedAt: new Date() },
        });
      } else {
        await tx.messages.delete({
          where: { id: messageId },
        });
      }

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.deleted',
        envelopes: [
          {
            event: 'chat:message_deleted',
            rooms: [`chat:${message.conversationId}`],
            payload: {
              messageId,
              conversationId: message.conversationId,
              deletedBy: req.user!.userId,
              forEveryone: Boolean(forEveryone),
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: message.conversationId,
        eventType: 'chat.message.deleted.cache.invalidate',
        tags: [`conversation:${message.conversationId}`],
      });
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('deleteMessage error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

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

    // Delete all messages in the conversation
    await prisma.messages.deleteMany({
      where: { conversationId },
    });

    // Delete the conversation itself
    await prisma.conversations.delete({
      where: { id: conversationId },
    });

    console.log(`Deleted conversation ${conversationId} and all its messages`);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('deleteConversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
};

export const editMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const messageId = ensureString(req.params.messageId);
    if (!messageId) {
      res.status(400).json({ error: 'Message ID is required' });
      return;
    }
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const message = await prisma.messages.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    if (message.senderId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to edit this message' });
      return;
    }

    const sender = await prismaRead.user.findUnique({
      where: { id: req.user.userId },
      select: userSelect,
    });
    const updated = await prisma.$transaction(async (tx) => {
      const nextMessage = await tx.messages.update({
        where: { id: messageId },
        data: { content, updatedAt: new Date() },
        include: {
          messages: {
            select: {
              id: true,
              content: true,
              contentType: true,
              senderId: true,
            },
          },
        },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.edited',
        envelopes: [
          {
            event: 'chat:message_edited',
            rooms: [`chat:${nextMessage.conversationId}`],
            payload: {
              messageId: nextMessage.id,
              conversationId: nextMessage.conversationId,
              content: nextMessage.content,
              editedAt: nextMessage.updatedAt,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: nextMessage.conversationId,
        eventType: 'chat.message.edited.cache.invalidate',
        tags: [`conversation:${nextMessage.conversationId}`],
      });

      return nextMessage;
    });

    res.status(200).json(mapMessagePayload(updated, sender, []));
  } catch (error) {
    console.error('editMessage error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
};

export const addReaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const messageId = ensureString(req.params.messageId);
    if (!messageId) {
      res.status(400).json({ error: 'Message ID is required' });
      return;
    }
    const { emoji } = req.body;

    if (!emoji) {
      res.status(400).json({ error: 'Emoji is required' });
      return;
    }

    const message = await prisma.messages.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const existingReaction = await prisma.message_reactions.findUnique({
      where: {
        messageId_userId: {
          messageId,
          userId: req.user.userId,
        },
      },
    });

    if (existingReaction) {
      if (existingReaction.emoji === emoji) {
        await prisma.$transaction(async (tx) => {
          await tx.message_reactions.delete({
            where: { id: existingReaction.id },
          });

          await enqueueRealtimeFanout(tx as any, {
            aggregateType: 'message',
            aggregateId: messageId,
            eventType: 'chat.message.reaction.removed',
            envelopes: [
              {
                event: 'chat:message_reaction',
                rooms: [`chat:${message.conversationId}`],
                payload: {
                  messageId,
                  conversationId: message.conversationId,
                  userId: req.user!.userId,
                  emoji,
                  action: 'removed',
                },
              },
            ],
          });
        });
        res.status(200).json({ action: 'removed', emoji });
        return;
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.message_reactions.update({
            where: { id: existingReaction.id },
            data: { emoji },
          });

          await enqueueRealtimeFanout(tx as any, {
            aggregateType: 'message',
            aggregateId: messageId,
            eventType: 'chat.message.reaction.updated',
            envelopes: [
              {
                event: 'chat:message_reaction',
                rooms: [`chat:${message.conversationId}`],
                payload: {
                  messageId,
                  conversationId: message.conversationId,
                  userId: req.user!.userId,
                  emoji,
                  action: 'updated',
                },
              },
            ],
          });
        });
        res.status(200).json({ action: 'updated', emoji });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.message_reactions.create({
        data: {
          id: randomUUID(),
          messageId,
          userId: req.user!.userId,
          emoji,
        },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.reaction.added',
        envelopes: [
          {
            event: 'chat:message_reaction',
            rooms: [`chat:${message.conversationId}`],
            payload: {
              messageId,
              conversationId: message.conversationId,
              userId: req.user!.userId,
              emoji,
              action: 'added',
            },
          },
        ],
      });
    });

    res.status(200).json({ action: 'added', emoji });
  } catch (error) {
    console.error('addReaction error:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
};

export const getUnreadCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const unreadCount = await prismaRead.messages.count({
      where: {
        receiverId: req.user.userId,
        status: { not: 'READ' },
      },
    });

    res.status(200).json({ unreadCount });
  } catch (error) {
    console.error('getUnreadCount error:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
};

export const searchMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const query = ensureString(req.query.q);
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;

    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const conversations = await prismaRead.conversations.findMany({
      where: {
        OR: [
          { participant1Id: req.user.userId },
          { participant2Id: req.user.userId },
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
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.status(200).json({ messages });
  } catch (error) {
    console.error('searchMessages error:', error);
    res.status(500).json({ error: 'Failed to search messages' });
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
    console.error('getMessageLimitStatus error:', error);
    res.status(500).json({ error: 'Failed to get message limit status' });
  }
};

export const getMessageRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const cursor = req.query.cursor as string | undefined;

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
      OR: [
        { participant1Id: req.user.userId },
        { participant2Id: req.user.userId },
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

    const formatted = results.map((conv) => {
      const convWithRelations = conv as typeof conv & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown; messages: unknown[] };
      const otherParticipant =
        conv.participant1Id === req.user!.userId
          ? convWithRelations.users_conversations_participant2IdTousers
          : convWithRelations.users_conversations_participant1IdTousers;

      return {
        id: conv.id,
        participant1Id: conv.participant1Id,
        participant2Id: conv.participant2Id,
        participant1: convWithRelations.users_conversations_participant1IdTousers,
        participant2: convWithRelations.users_conversations_participant2IdTousers,
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

    const conversations = await prismaRead.conversations.findMany({
      where: {
        OR: [
          { participant1Id: req.user.userId },
          { participant2Id: req.user.userId },
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

    const convWithRelations = conversation as typeof conversation & { users_conversations_participant1IdTousers: unknown; users_conversations_participant2IdTousers: unknown };
    const otherParticipant =
      conversation.participant1Id === req.user.userId
        ? convWithRelations.users_conversations_participant2IdTousers
        : convWithRelations.users_conversations_participant1IdTousers;

    res.status(200).json({
      message: 'Message request accepted',
      conversation: {
        id: conversation.id,
        participant1Id: conversation.participant1Id,
        participant2Id: conversation.participant2Id,
        participant1: convWithRelations.users_conversations_participant1IdTousers,
        participant2: convWithRelations.users_conversations_participant2IdTousers,
        otherParticipant,
        lastMessage: null,
        lastMessageAt: conversation.lastMessageAt?.toISOString() || null,
        unreadCount: 0,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('acceptMessageRequest error:', error);
    res.status(500).json({ error: 'Failed to accept message request' });
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

    await prisma.messages.deleteMany({
      where: { conversationId },
    });

    await prisma.conversations.delete({
      where: { id: conversationId },
    });

    res.status(200).json({ message: 'Message request declined' });
  } catch (error) {
    console.error('declineMessageRequest error:', error);
    res.status(500).json({ error: 'Failed to decline message request' });
  }
};
