import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma, prismaRead } from '../config/prisma';
import { enqueueCacheInvalidation, enqueueRealtimeFanout } from '../outbox/helpers';
import type { RealtimeEnvelope } from '../infrastructure/realtime/channels';
import { emitRealtimeEnvelopes } from '../infrastructure/realtime/emitter';
import { cacheService } from '../services/cache.service';
import { ensureString } from '../utils/request.util';
import { isPrismaConnectionError } from '../utils/prisma-error.util';
import {
  maskReadReceiptForViewer,
  shouldNotifySenderAboutReadReceipt,
} from '../services/chat-read-receipts.service';
import { getReadReceiptVisibilityCached, sendChatMessage } from '../services/chat-message.service';
import { invalidateConversationParticipants } from '../services/chat-conversation-cache.service';
import {
  getPremiumVisibilityByUserIds,
  type PremiumVisibilityState,
} from '../services/premium-visibility.service';
import {
  assertUsersCanInteract,
  enforceTrustTierLimit,
  publicTrustFields,
  safetyErrorResponse,
  trustLevelRank,
} from '../services/trust-safety.service';
import {
  clampPageSize,
  createdAtDescKeysetWhere,
  decodeKeysetCursor,
  decodeLegacyDateCursor,
  encodeKeysetCursor,
} from '../utils/keyset-pagination.util';

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
  isVerified: true,
  profileBadgeStyle: true,
  identityTrustLevel: true,
};

const uniqueTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

const chatUserCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueTags(userIds.filter(Boolean).map((userId) => `chat:user:${userId}`));

const notificationCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueTags(userIds.filter(Boolean).map((userId) => `notifications:${userId}`));

const conversationCacheTags = (
  conversationId: string,
  ...participantIds: Array<string | null | undefined>
): string[] =>
  uniqueTags([
    `conversation:${conversationId}`,
    ...chatUserCacheTags(...participantIds),
    ...notificationCacheTags(...participantIds),
  ]);

const messageCacheTags = (message: {
  conversationId: string;
  senderId: string;
  receiverId: string;
}): string[] => conversationCacheTags(message.conversationId, message.senderId, message.receiverId);

const invalidateChatCaches = async (tags: string[]): Promise<void> => {
  const dedupedTags = uniqueTags(tags);
  if (dedupedTags.length === 0) {
    return;
  }

  try {
    await cacheService.invalidateTags(...dedupedTags);
  } catch (error) {
    console.error('chat cache invalidation failed:', error);
  }
};

const buildFallbackChatUser = (userId: string) => ({
  id: userId,
  username: '',
  name: '',
  profileImage: null,
  isOnline: false,
  lastActiveAt: null,
  isVerified: false,
  profileBadgeStyle: null,
  identityTrustLevel: 'BASIC',
  verificationBadges: [],
  isPremium: false,
});

export function buildChatUserIdentity<T extends { id?: string | null; profileBadgeStyle?: string | null; identityTrustLevel?: string | null }>(
  user: T,
  premiumVisibilityByUser: Map<string, Pick<PremiumVisibilityState, 'isPremium'>>
): T & { profileBadgeStyle: string | null; isPremium: boolean; identityTrustLevel: string; verificationBadges: string[] } {
  const userId = String(user?.id || '');
  const isPremium = Boolean(userId && premiumVisibilityByUser.get(userId)?.isPremium);
  const earnedStudentBadge =
    user.profileBadgeStyle?.toLowerCase() === 'student' &&
    trustLevelRank(user.identityTrustLevel) >= trustLevelRank('STUDENT_VERIFIED');
  return {
    ...user,
    profileBadgeStyle: isPremium || earnedStudentBadge ? user.profileBadgeStyle ?? null : null,
    isPremium,
    ...publicTrustFields(user.identityTrustLevel),
  };
}

const getChatPremiumVisibilityByUserIds = async (
  userIds: string[]
): Promise<Map<string, PremiumVisibilityState>> => {
  try {
    return await getPremiumVisibilityByUserIds(userIds);
  } catch (error) {
    console.error('chat premium visibility lookup failed:', error);
    return new Map();
  }
};

const toIsoString = (value: unknown): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
};

// Memoized in chat-message.service: this check fans out into several queries
// and runs on every conversation/messages list request.
const getReadReceiptVisibility = getReadReceiptVisibilityCached;

const maskLastMessagePayload = (
  message: any,
  viewerUserId: string,
  viewerCanUseReadReceipts: boolean
) => {
  if (!message) return null;
  return maskReadReceiptForViewer(message, viewerUserId, viewerCanUseReadReceipts);
};

const mapMessagePayload = (
  message: any,
  sender: any,
  reactions: { id: string; userId: string; emoji: string }[] = [],
  options: { viewerUserId?: string; viewerCanUseReadReceipts?: boolean } = {}
) => {
  const visibleMessage = maskReadReceiptForViewer(
    message,
    options.viewerUserId,
    Boolean(options.viewerCanUseReadReceipts)
  );

  return {
    id: visibleMessage.id,
    clientMessageId: visibleMessage.clientMessageId || undefined,
    conversationId: visibleMessage.conversationId,
    senderId: visibleMessage.senderId,
    receiverId: visibleMessage.receiverId,
    content: visibleMessage.content,
    contentType: visibleMessage.contentType,
    mediaUrl: visibleMessage.mediaUrl,
    mediaType: visibleMessage.mediaType,
    fileName: visibleMessage.fileName,
    fileSize: visibleMessage.fileSize,
    status: visibleMessage.status,
    deliveredAt: toIsoString(visibleMessage.deliveredAt),
    readAt: toIsoString(visibleMessage.readAt),
    editedAt: toIsoString(visibleMessage.editedAt),
    isEdited: Boolean(visibleMessage.editedAt),
    isDeleted: visibleMessage.isDeleted,
    replyToId: visibleMessage.replyToId,
    replyTo: (visibleMessage as typeof visibleMessage & { messages: unknown }).messages,
    sender: sender || buildFallbackChatUser(visibleMessage.senderId),
    reactions: reactions.map((reaction) => ({
      id: reaction.id,
      userId: reaction.userId,
      emoji: reaction.emoji,
      user: { id: reaction.userId, username: '', name: '' },
    })),
    createdAt: visibleMessage.createdAt.toISOString(),
    updatedAt: visibleMessage.updatedAt.toISOString(),
  };
};

const getChatUserLookup = async (userIds: string[]): Promise<Map<string, any>> => {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueUserIds.length === 0) {
    return new Map();
  }

  const users = await prismaRead.user.findMany({
    where: { id: { in: uniqueUserIds } },
    select: userSelect,
  });
  const premiumVisibilityByUser = await getChatPremiumVisibilityByUserIds(uniqueUserIds);

  return new Map(
    users.map((user) => [
      user.id,
      buildChatUserIdentity(user, premiumVisibilityByUser),
    ])
  );
};

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

    const whereClause: any = {
      OR: [
        { participant1Id: req.user.userId },
        { participant2Id: req.user.userId },
      ],
    };

    if (cursor?.t) {
      const cursorDate = new Date(cursor.t);
      whereClause.AND = [{
        OR: [
          { lastMessageAt: { lt: cursorDate } },
          { lastMessageAt: cursorDate, id: { lt: cursor.id } },
        ],
      }];
    } else if (legacyCursorDate) {
      whereClause.lastMessageAt = { lt: legacyCursorDate };
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
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
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

    const whereClause: any = { conversationId };
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
    const result = await sendChatMessage({
      senderId: req.user.userId,
      conversationId,
      content: req.body.content,
      contentType: req.body.contentType,
      mediaUrl: req.body.mediaUrl,
      mediaType: req.body.mediaType,
      fileName: req.body.fileName,
      fileSize: req.body.fileSize,
      replyToId: req.body.replyToId,
      clientMessageId: req.body.clientMessageId,
    });

    if (!result.wasDuplicate) {
      emitRealtimeEnvelopes(result.realtimeEnvelopes);
    }
    res.status(result.wasDuplicate ? 200 : 201).json(result.message);
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    const message = error instanceof Error ? error.message : '';
    if (message === 'Content or media is required') {
      res.status(400).json({ error: message });
      return;
    }
    if (message === 'Conversation not found') {
      res.status(404).json({ error: message });
      return;
    }
    if (message === 'Reply target is invalid for this conversation') {
      res.status(400).json({ error: message });
      return;
    }
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

    const realtimeEnvelopes: RealtimeEnvelope[] = [
      {
        event: 'chat:message_deleted',
        rooms: [`chat:${message.conversationId}`],
        payload: {
          messageId,
          conversationId: message.conversationId,
          deletedBy: req.user.userId,
          forEveryone: Boolean(forEveryone),
        },
      },
    ];
    const cacheTags = messageCacheTags(message);

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
        envelopes: realtimeEnvelopes,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: message.conversationId,
        eventType: 'chat.message.deleted.cache.invalidate',
        tags: cacheTags,
      });
    });

    await invalidateChatCaches(cacheTags);
    emitRealtimeEnvelopes(realtimeEnvelopes);
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
        eventType: 'chat.conversation.deleted.cache.invalidate',
        tags: cacheTags,
      });
    });

    await invalidateChatCaches(cacheTags);
    invalidateConversationParticipants(conversationId);
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

    const senderRecord = await prismaRead.user.findUnique({
      where: { id: req.user.userId },
      select: userSelect,
    });
    const senderPremiumVisibility = await getChatPremiumVisibilityByUserIds([req.user.userId]);
    const sender = senderRecord
      ? buildChatUserIdentity(senderRecord, senderPremiumVisibility)
      : null;
    let realtimeEnvelopes: RealtimeEnvelope[] = [];
    const cacheTags = messageCacheTags(message);
    const updated = await prisma.$transaction(async (tx) => {
      const editedAt = new Date();
      const nextMessage = await tx.messages.update({
        where: { id: messageId },
        data: { content, editedAt, updatedAt: editedAt },
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

      realtimeEnvelopes = [
        {
          event: 'chat:message_edited',
          rooms: [`chat:${nextMessage.conversationId}`],
          dedupeKey: `chat:message_edited:${nextMessage.id}:${editedAt.getTime()}`,
          payload: {
            messageId: nextMessage.id,
            conversationId: nextMessage.conversationId,
            content: nextMessage.content,
            editedAt: editedAt.toISOString(),
          },
        },
      ];

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'message',
        aggregateId: messageId,
        eventType: 'chat.message.edited',
        envelopes: realtimeEnvelopes,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: nextMessage.conversationId,
        eventType: 'chat.message.edited.cache.invalidate',
        tags: cacheTags,
      });

      return nextMessage;
    });

    await invalidateChatCaches(cacheTags);
    emitRealtimeEnvelopes(realtimeEnvelopes);
    const viewerCanUseReadReceipts = await getReadReceiptVisibility(req.user.userId);
    res.status(200).json(mapMessagePayload(updated, sender, [], {
      viewerUserId: req.user.userId,
      viewerCanUseReadReceipts,
    }));
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
    if (message.isDeleted || (message.senderId !== req.user.userId && message.receiverId !== req.user.userId)) {
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

    const buildReactionEnvelopes = (action: 'added' | 'removed' | 'updated'): RealtimeEnvelope[] => [
      {
        event: 'chat:message_reaction',
        rooms: [`chat:${message.conversationId}`],
        payload: {
          messageId,
          conversationId: message.conversationId,
          userId: req.user!.userId,
          emoji,
          action,
        },
      },
    ];
    const cacheTags = messageCacheTags(message);

    if (existingReaction) {
      if (existingReaction.emoji === emoji) {
        const realtimeEnvelopes = buildReactionEnvelopes('removed');
        await prisma.$transaction(async (tx) => {
          await tx.message_reactions.delete({
            where: { id: existingReaction.id },
          });

          await enqueueRealtimeFanout(tx as any, {
            aggregateType: 'message',
            aggregateId: messageId,
            eventType: 'chat.message.reaction.removed',
            envelopes: realtimeEnvelopes,
          });

          await enqueueCacheInvalidation(tx as any, {
            aggregateType: 'conversation',
            aggregateId: message.conversationId,
            eventType: 'chat.message.reaction.removed.cache.invalidate',
            tags: cacheTags,
          });
        });
        await invalidateChatCaches(cacheTags);
        emitRealtimeEnvelopes(realtimeEnvelopes);
        res.status(200).json({ action: 'removed', emoji });
        return;
      } else {
        const realtimeEnvelopes = buildReactionEnvelopes('updated');
        await prisma.$transaction(async (tx) => {
          await tx.message_reactions.update({
            where: { id: existingReaction.id },
            data: { emoji },
          });

          await enqueueRealtimeFanout(tx as any, {
            aggregateType: 'message',
            aggregateId: messageId,
            eventType: 'chat.message.reaction.updated',
            envelopes: realtimeEnvelopes,
          });

          await enqueueCacheInvalidation(tx as any, {
            aggregateType: 'conversation',
            aggregateId: message.conversationId,
            eventType: 'chat.message.reaction.updated.cache.invalidate',
            tags: cacheTags,
          });
        });
        await invalidateChatCaches(cacheTags);
        emitRealtimeEnvelopes(realtimeEnvelopes);
        res.status(200).json({ action: 'updated', emoji });
        return;
      }
    }

    const realtimeEnvelopes = buildReactionEnvelopes('added');
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
        envelopes: realtimeEnvelopes,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'conversation',
        aggregateId: message.conversationId,
        eventType: 'chat.message.reaction.added.cache.invalidate',
        tags: cacheTags,
      });
    });

    await invalidateChatCaches(cacheTags);
    emitRealtimeEnvelopes(realtimeEnvelopes);
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
