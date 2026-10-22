import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { getOrCreateConversationForUsers } from "../../../chat/services/conversation-pair.service";
import { randomUUID } from "crypto";
import { getIO } from "../../../../realtime/socket-registry";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { AuthRequest, chatUserSelect, buildChatMessagePayload } from "./support.controller";

export const sendPremiumAdminUserMessage = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.params.id || '');
    if (!userId) {
      res.status(400).json({ error: 'User id is required' });
      return;
    }

    const content =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';

    if (!content) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (content.length > 1000) {
      res.status(400).json({ error: 'Message must be 1000 characters or less' });
      return;
    }

    const [targetUser, sender] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, isBanned: true },
      }),
      prisma.user.findUnique({
        where: { id: adminId },
        select: chatUserSelect,
      }),
    ]);

    if (!targetUser || targetUser.isBanned) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const conversation = await getOrCreateConversationForUsers(adminId, userId);
    const message = await prisma.messages.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        senderId: adminId,
        receiverId: userId,
        content,
        contentType: 'text',
        status: 'SENT',
        updatedAt: new Date(),
      },
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

    await prisma.conversations.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const messagePayload = buildChatMessagePayload(message, sender);
    const io = getIO();

    if (io) {
      io.to(`chat:${conversation.id}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });
      io.to(`user:${adminId}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });
      io.to(`user:${userId}`).emit('chat:notification', {
        type: 'new_message',
        conversationId: conversation.id,
        message: messagePayload,
        sender,
      });
    }

    if (sender) {
      const preview =
        content.length > 100 ? `${content.slice(0, 97)}...` : content;
      pushNotificationService
        .pushNewMessage(
          userId,
          sender.name || sender.username || 'Admin',
          preview,
          conversation.id,
          adminId,
          sender.profileImage || undefined,
          {
            id: messagePayload.id,
            clientMessageId: messagePayload.clientMessageId,
            content: messagePayload.content,
            contentType: messagePayload.contentType,
            mediaUrl: messagePayload.mediaUrl,
            mediaType: messagePayload.mediaType,
            fileName: messagePayload.fileName,
            fileSize: messagePayload.fileSize,
            createdAt: messagePayload.createdAt,
            updatedAt: messagePayload.updatedAt,
          }
        )
        .catch(console.error);
    }

    res.status(201).json({
      message: 'Admin message sent successfully',
      conversationId: conversation.id,
      directMessage: messagePayload,
    });
  } catch (error) {
    console.error('sendPremiumAdminUserMessage error:', error);
    res.status(500).json({ error: 'Failed to send admin message' });
  }
};
