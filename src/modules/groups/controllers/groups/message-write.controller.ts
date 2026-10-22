import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { getIO } from "../../../../realtime/socket-registry";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { buildGroupMessagePreview } from "./shortcuts.controller";

/**
 * Send group message
 * POST /api/groups/:groupId/messages
 */
export const sendGroupMessage = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = ensureString(req.params.groupId);
    const { content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId } = req.body;
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    // Verify user is member of group
    const membership = await prisma.group_members.findUnique({
      where: {
        groupId_userId: { groupId, userId: String(req.user.userId) },
      },
    });

    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        iconImage: true,
        imageUrl: true,
        coverImage: true,
        group_members: {
          where: {
            userId: { not: String(req.user.userId) },
          },
          select: { userId: true },
        },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const replyMessageId = replyToId != null ? ensureString(replyToId) : null;
    if (replyMessageId) {
      const replyMessage = await prisma.group_messages.findFirst({
        where: { id: replyMessageId, groupId, isDeleted: false },
        select: { id: true },
      });
      if (!replyMessage) {
        res.status(400).json({ error: 'Reply target is not in this group' });
        return;
      }
    }

    // Create message in database
    const message = await prisma.group_messages.create({
      data: {
        id: randomUUID(),
        groupId,
        senderId: String(req.user.userId),
        content: content || '',
        contentType: contentType || 'text',
        mediaUrl,
        mediaType,
        fileName,
        fileSize,
        replyToId: replyMessageId || undefined,
        updatedAt: new Date(),
      },
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            isVerified: true,
            profileBadgeStyle: true,
          },
        },
        group_messages: {
          select: {
            id: true,
            content: true,
            senderId: true,
          },
        },
      },
    });

    const msg = message as typeof message & { users: unknown; group_messages: unknown };
    const messagePayload = {
      id: msg.id,
      groupId: msg.groupId,
      senderId: msg.senderId,
      sender: msg.users,
      content: msg.content,
      contentType: msg.contentType,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      replyToId: msg.replyToId,
      replyTo: msg.group_messages,
      reactions: [],
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString(),
    };

    const sender = msg.users as { name?: string | null; username?: string | null; profileImage?: string | null } | null;
    const senderName = sender?.name || sender?.username || 'Someone';
    const groupImage = group.iconImage || group.imageUrl || group.coverImage || undefined;
    const preview = buildGroupMessagePreview(message.content, message.contentType);
    const recipientIds = group.group_members.map((member) => member.userId);

    getIO()?.to(`group:${groupId}`).emit('group:new_message', {
      ...messagePayload,
      groupName: group.name,
      groupImage: groupImage || '',
    });

    if (recipientIds.length > 0) {
      pushNotificationService.pushGroupMessageToUsers(
        recipientIds,
        group.name,
        senderName,
        preview,
        groupId,
        String(req.user.userId),
        groupImage,
        sender?.profileImage || undefined
      ).catch(console.error);
    }

    res.status(201).json(messagePayload);
  } catch (error) {
    console.error('Error sending group message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};
