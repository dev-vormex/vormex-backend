import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { getIO } from "../../../../realtime/socket-registry";
import { AuthRequest } from "./support.controller";
import { GROUP_CHAT_CLEAR_CONFIRMATION, collectGroupChatMediaAssets, deleteBunnyAssets, collectChatMediaAssets, CHAT_CLEAR_CONFIRMATION } from "./media-cleanup.controller";

export const clearAdminGroupChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const confirmText = typeof req.body?.confirmText === 'string'
      ? req.body.confirmText.trim()
      : '';

    if (confirmText !== GROUP_CHAT_CLEAR_CONFIRMATION) {
      res.status(400).json({
        error: `Type "${GROUP_CHAT_CLEAR_CONFIRMATION}" to clear this group chat.`,
        confirmationText: GROUP_CHAT_CLEAR_CONFIRMATION,
      });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, name: true },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const chatMediaAssets = await collectGroupChatMediaAssets(groupId);
    const mediaDeletion = await deleteBunnyAssets(chatMediaAssets.urls);

    if (mediaDeletion.failed > 0) {
      res.status(502).json({
        error: 'Some group chat media files could not be deleted. Database rows were left in place so the clear can be retried.',
        media: {
          filesFound: chatMediaAssets.urls.length,
          bytesFromRows: chatMediaAssets.bytes,
          deleted: mediaDeletion.deleted,
          failed: mediaDeletion.failed,
          failedUrls: mediaDeletion.failedUrls,
        },
      });
      return;
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const groupMessages = await tx.group_messages.count({ where: { groupId } });
      const groupReactions = await tx.group_message_reactions.count({
        where: { group_messages: { groupId } },
      });

      await tx.group_messages.updateMany({
        where: { groupId },
        data: { replyToId: null },
      });
      await tx.group_messages.deleteMany({ where: { groupId } });
      await tx.groups.update({
        where: { id: groupId },
        data: { updatedAt: new Date() },
      });

      return {
        groupMessages,
        groupReactions,
      };
    }, {
      maxWait: 15_000,
      timeout: 60_000,
    });

    getIO()?.to(`group:${groupId}`).emit('group:chat_cleared', {
      groupId,
      clearedBy: String(req.user.userId),
      clearedAt: new Date().toISOString(),
    });

    res.json({
      message: 'Group chat cleared successfully',
      group: {
        id: group.id,
        name: group.name,
      },
      deleted,
      media: {
        filesFound: chatMediaAssets.urls.length,
        bytesFromRows: chatMediaAssets.bytes,
        deleted: mediaDeletion.deleted,
        failed: mediaDeletion.failed,
      },
    });
  } catch (error) {
    console.error('clearAdminGroupChat error:', error);
    res.status(500).json({ error: 'Failed to clear group chat' });
  }
};

// ============================================
// CHAT STORAGE
// ============================================

export const getChatStorageSummary = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [
      conversations,
      directMessages,
      groupMessages,
      directReactions,
      groupReactions,
      messageNotifications,
      moderationChatReports,
      chatMediaAssets,
    ] = await Promise.all([
      prisma.conversations.count(),
      prisma.messages.count(),
      prisma.group_messages.count(),
      prisma.message_reactions.count(),
      prisma.group_message_reactions.count(),
      prisma.notifications.count({
        where: {
          OR: [
            { messageId: { not: null } },
            { type: { in: ['message', 'new_message', 'group_message'] } },
          ],
        },
      }),
      prisma.moderation_reports.count({
        where: { conversationId: { not: null } },
      }),
      collectChatMediaAssets(),
    ]);

    res.json({
      confirmationText: CHAT_CLEAR_CONFIRMATION,
      summary: {
        conversations,
        directMessages,
        groupMessages,
        directReactions,
        groupReactions,
        messageNotifications,
        moderationChatReports,
        mediaMessages: chatMediaAssets.directMediaRows + chatMediaAssets.groupMediaRows,
        chatUploadFiles: chatMediaAssets.urls.length,
        chatUploadBytes: chatMediaAssets.bytes,
      },
    });
  } catch (error) {
    console.error('getChatStorageSummary error:', error);
    res.status(500).json({ error: 'Failed to load chat storage summary' });
  }
};

export const clearAllChats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const confirmText = typeof req.body?.confirmText === 'string'
      ? req.body.confirmText.trim()
      : '';

    if (confirmText !== CHAT_CLEAR_CONFIRMATION) {
      res.status(400).json({
        error: `Type "${CHAT_CLEAR_CONFIRMATION}" to clear every chat.`,
        confirmationText: CHAT_CLEAR_CONFIRMATION,
      });
      return;
    }

    const chatMediaAssets = await collectChatMediaAssets();
    const mediaDeletion = await deleteBunnyAssets(chatMediaAssets.urls);

    if (mediaDeletion.failed > 0) {
      res.status(502).json({
        error: 'Some chat media files could not be deleted. Database rows were left in place so the clear can be retried.',
        media: {
          filesFound: chatMediaAssets.urls.length,
          bytesFromRows: chatMediaAssets.bytes,
          deleted: mediaDeletion.deleted,
          failed: mediaDeletion.failed,
          failedUrls: mediaDeletion.failedUrls,
        },
      });
      return;
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const messageNotifications = await tx.notifications.deleteMany({
        where: {
          OR: [
            { messageId: { not: null } },
            { type: { in: ['message', 'new_message', 'group_message'] } },
          ],
        },
      });

      const moderationReportsDetached = await tx.moderation_reports.updateMany({
        where: { conversationId: { not: null } },
        data: { conversationId: null },
      });

      const outboxEvents = await tx.outboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateType: { in: ['message', 'conversation', 'group_message'] } },
            { eventType: { startsWith: 'chat.' } },
            { eventType: { startsWith: 'group.message.' } },
          ],
        },
      });

      await tx.messages.updateMany({ data: { replyToId: null } });
      await tx.group_messages.updateMany({ data: { replyToId: null } });

      const directReactions = await tx.message_reactions.deleteMany({});
      const groupReactions = await tx.group_message_reactions.deleteMany({});
      const directMessages = await tx.messages.deleteMany({});
      const conversations = await tx.conversations.deleteMany({});
      const groupMessages = await tx.group_messages.deleteMany({});

      return {
        conversations: conversations.count,
        directMessages: directMessages.count,
        groupMessages: groupMessages.count,
        directReactions: directReactions.count,
        groupReactions: groupReactions.count,
        messageNotifications: messageNotifications.count,
        moderationReportsDetached: moderationReportsDetached.count,
        outboxEvents: outboxEvents.count,
      };
    }, {
      maxWait: 15_000,
      timeout: 120_000,
    });

    getIO()?.emit('chat:cleared', {
      clearedBy: String(req.user.userId),
      clearedAt: new Date().toISOString(),
    });
    getIO()?.emit('group:chat_cleared', {
      clearedBy: String(req.user.userId),
      clearedAt: new Date().toISOString(),
    });

    res.json({
      message: 'All chats cleared successfully',
      deleted,
      media: {
        filesFound: chatMediaAssets.urls.length,
        bytesFromRows: chatMediaAssets.bytes,
        deleted: mediaDeletion.deleted,
        failed: mediaDeletion.failed,
      },
    });
  } catch (error) {
    console.error('clearAllChats error:', error);
    res.status(500).json({ error: 'Failed to clear chats' });
  }
};
