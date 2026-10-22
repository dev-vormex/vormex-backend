import type { SocketHandlerInput } from '../types';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import { pushNotificationService } from '../../modules/notifications/services/push-notification.service';

export function registerGroupsSocketHandlers({ io, socket, context }: SocketHandlerInput): void {
  const {
    groupOnlineCounts,
    groupTypingUserMemo,
    allowGroupSocketAction,
    getSocketUserId,
    chatUserSelect,
    buildGroupMessagePreview,
  } = context;

  // ============================================
  // GROUP CHAT SOCKET EVENTS
  // ============================================

  // Join group chat room
  socket.on('group:join', async ({ groupId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (typeof groupId !== 'string' || !groupId.trim() || groupId.length > 128) return;
    if (!(await allowGroupSocketAction(socket, userId, 'join'))) return;

    // Verify user is member of group
    const membership = await prisma.group_members.findUnique({
      where: {
        groupId_userId: { groupId, userId },
      },
    });

    if (!membership) {
      socket.emit('error', { message: 'Not a member of this group' });
      return;
    }

    socket.join(`group:${groupId}`);

    // Track online users
    if (!groupOnlineCounts.has(groupId)) {
      groupOnlineCounts.set(groupId, new Set());
    }
    groupOnlineCounts.get(groupId)!.add(userId);

    const onlineCount = groupOnlineCounts.get(groupId)!.size;

    // Notify group of new user
    io.to(`group:${groupId}`).emit('group:user_joined', {
      groupId,
      userId,
      onlineCount,
    });

    console.log(`User ${userId} joined group:${groupId}`);
  });

  // Leave group chat room
  socket.on('group:leave', ({ groupId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    socket.leave(`group:${groupId}`);

    // Update online count
    if (groupOnlineCounts.has(groupId)) {
      groupOnlineCounts.get(groupId)!.delete(userId);
      const onlineCount = groupOnlineCounts.get(groupId)!.size;

      io.to(`group:${groupId}`).emit('group:user_left', {
        groupId,
        userId,
        onlineCount,
      });
    }
  });

  // Group typing indicator
  socket.on('group:typing', async ({ groupId, isTyping }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (!groupId || !socket.rooms.has(`group:${groupId}`)) {
      return;
    }
    if (typeof groupId !== 'string' || groupId.length > 128) return;
    if (!(await allowGroupSocketAction(socket, userId, 'typing'))) return;

    try {
      const user = await groupTypingUserMemo.get(userId, () =>
        prisma.user.findUnique({
          where: { id: userId },
          select: chatUserSelect,
        })
      );
      if (!user) return;

      socket.to(`group:${groupId}`).emit('group:user_typing', {
        groupId,
        user,
        isTyping: Boolean(isTyping),
      });
    } catch (error) {
      console.error('group:typing error:', error);
    }
  });

  // Send group message
  socket.on('group:message', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const { groupId, content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId, tempId } = data;
      if (
        typeof groupId !== 'string' ||
        !groupId.trim() ||
        groupId.length > 128 ||
        (typeof content === 'string' && content.length > 8_000) ||
        (typeof fileName === 'string' && fileName.length > 255)
      ) {
        socket.emit('error', { message: 'Invalid group message payload' });
        return;
      }
      if (!(await allowGroupSocketAction(socket, userId, 'message'))) return;

      // Verify membership
      const membership = await prisma.group_members.findUnique({
        where: {
          groupId_userId: { groupId, userId },
        },
      });

      if (!membership) {
        socket.emit('error', { message: 'Not a member of this group' });
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
              userId: { not: userId },
            },
            select: { userId: true },
          },
        },
      });

      if (!group) {
        socket.emit('error', { message: 'Group not found' });
        return;
      }
      const replyMessageId = replyToId ? String(replyToId).trim() : null;
      const replyMessage = replyMessageId
        ? await prisma.group_messages.findFirst({
            where: { id: replyMessageId, groupId, isDeleted: false },
            select: { id: true, content: true, senderId: true },
          })
        : null;
      if (replyMessageId && !replyMessage) {
        socket.emit('error', { message: 'Reply target is not in this group' });
        return;
      }

      // Create message in database
      const message = await prisma.group_messages.create({
        data: {
          id: randomUUID(),
          groupId,
          senderId: userId,
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
            select: chatUserSelect,
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

      const messagePayload = {
        id: message.id,
        groupId: message.groupId,
        senderId: message.senderId,
        sender: (message as typeof message & { users: unknown }).users,
        content: message.content,
        contentType: message.contentType,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        fileName: message.fileName,
        fileSize: message.fileSize,
        replyToId: message.replyToId,
        replyTo: (message as typeof message & { group_messages: unknown }).group_messages || replyMessage,
        reactions: [],
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
        tempId,
      };

      // Broadcast to group
      const groupImage = group.iconImage || group.imageUrl || group.coverImage || undefined;
      io.to(`group:${groupId}`).emit('group:new_message', {
        ...messagePayload,
        groupName: group.name,
        groupImage: groupImage || '',
      });

      const sender = (message as typeof message & { users: any }).users;
      const recipientIds = group.group_members.map((member: { userId: string }) => member.userId);
      if (recipientIds.length > 0) {
        pushNotificationService
          .pushGroupMessageToUsers(
            recipientIds,
            group.name,
            sender?.name || sender?.username || 'Someone',
            buildGroupMessagePreview(message.content, message.contentType),
            groupId,
            userId,
            groupImage,
            sender?.profileImage || undefined
          )
          .catch(console.error);
      }

      console.log(`Group message sent in ${groupId} by user ${userId}`);
    } catch (error) {
      console.error('group:message error:', error);
      socket.emit('error', { message: 'Failed to send group message' });
    }
  });

  // Delete group message
  socket.on('group:delete_message', async ({ groupId, messageId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (
      typeof groupId !== 'string' ||
      groupId.length > 128 ||
      typeof messageId !== 'string' ||
      !messageId.trim() ||
      messageId.length > 128
    )
      return;
    if (!(await allowGroupSocketAction(socket, userId, 'delete_message'))) return;

    try {
      const message = await prisma.group_messages.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          groupId: true,
          senderId: true,
          isDeleted: true,
          groups: { select: { creatorId: true } },
        },
      });

      if (!message || (groupId && message.groupId !== groupId)) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }

      const membership = await prisma.group_members.findUnique({
        where: { groupId_userId: { groupId: message.groupId, userId } },
        select: { role: true },
      });
      if (!membership) {
        socket.emit('error', { message: 'Not a member of this group' });
        return;
      }

      const role = message.groups.creatorId === userId ? 'owner' : String(membership.role || '').toLowerCase();
      const canModerate = ['owner', 'admin', 'moderator'].includes(role);
      if (message.senderId !== userId && !canModerate) {
        socket.emit('error', { message: 'Cannot delete this message' });
        return;
      }

      if (!message.isDeleted) {
        await prisma.group_messages.update({
          where: { id: messageId },
          data: { isDeleted: true, content: '', updatedAt: new Date() },
        });
      }

      io.to(`group:${message.groupId}`).emit('group:message_deleted', {
        groupId: message.groupId,
        messageId,
        deletedBy: userId,
      });
    } catch (error) {
      console.error('group:delete_message error:', error);
      socket.emit('error', { message: 'Failed to delete group message' });
    }
  });
}
