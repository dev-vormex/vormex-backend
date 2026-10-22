import type { SocketHandlerInput } from '../types';
import { randomUUID } from 'crypto';
import { prisma } from '../../config/prisma';
import { logger } from '../../infrastructure/logging/logger';
import { getReadReceiptVisibilityCached, sendChatMessage, warmChatSendPath } from '../../modules/chat/services/chat-message.service';
import { emitRealtimeEnvelopes } from '../../infrastructure/realtime/emitter';
import { shouldNotifySenderAboutReadReceipt } from '../../modules/chat/services/chat-read-receipts.service';
import { recordActivity } from '../../modules/engagement/services/activity.service';
import { updateEngagementStreak } from '../../modules/engagement/services/streak.service';
import { assertUsersCanInteract, safetyErrorResponse } from '../../modules/safety/services/trust-safety.service';

export function registerChatSocketHandlers({ io, socket, context }: SocketHandlerInput): void {
  const {
    getSharedChatPresence,
    allowChatTypingBroadcast,
    getSocketUserId,
    emitToUser,
    isConversationParticipant,
    getConversationPeerId,
  } = context;

  // ============================================
  // CHAT SOCKET EVENTS
  // ============================================

  // Join chat room (handle both { conversationId } and data?.conversationId for mobile clients)
  socket.on('chat:join', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    const conversationId = data?.conversationId ?? data;
    if (conversationId && typeof conversationId === 'string') {
      try {
        const allowed = await isConversationParticipant(conversationId, userId);
        if (!allowed) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }
        const peerId = await getConversationPeerId(conversationId, userId);
        if (!peerId) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }
        await assertUsersCanInteract(userId, peerId, 'conversation');

        socket.join(`chat:${conversationId}`);
        logger.info({
          event: 'chat.room.joined',
          socketId: socket.id,
          userId,
          conversationId,
          transport: socket.conn.transport.name,
          rooms: Array.from(socket.rooms),
        });
        void warmChatSendPath(conversationId, userId).catch(() => undefined);
      } catch (error) {
        const safety = safetyErrorResponse(error);
        if (safety) {
          socket.emit('error', safety.body);
          return;
        }
        console.error('chat:join error:', error);
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    } else {
      console.warn('chat:join received invalid data:', JSON.stringify(data));
    }
  });

  // Leave chat room
  socket.on('chat:leave', (data) => {
    const conversationId = data?.conversationId ?? data;
    if (conversationId && typeof conversationId === 'string') {
      socket.leave(`chat:${conversationId}`);
      logger.info({
        event: 'chat.room.left',
        socketId: socket.id,
        userId: getSocketUserId(socket) || undefined,
        conversationId,
        rooms: Array.from(socket.rooms),
      });
    }
  });

  // Send chat message
  socket.on('chat:send_message', async (data, ack) => {
    const acknowledge = typeof ack === 'function' ? ack : undefined;
    const failSend = (message: string) => {
      socket.emit('error', { message });
      acknowledge?.({ ok: false, error: message });
    };
    const senderId = getSocketUserId(socket);
    if (!senderId) {
      failSend('Not authenticated');
      return;
    }

    try {
      const payload = data && typeof data === 'object' ? data : {};
      const {
        conversationId,
        content,
        contentType,
        mediaUrl,
        mediaType,
        fileName,
        fileSize,
        replyToId,
        clientMessageId,
      } = payload as {
        conversationId?: unknown;
        content?: unknown;
        contentType?: unknown;
        mediaUrl?: unknown;
        mediaType?: unknown;
        fileName?: unknown;
        fileSize?: unknown;
        replyToId?: unknown;
        clientMessageId?: unknown;
      };
      if (!conversationId || (!content && !mediaUrl)) {
        failSend('Content or media is required');
        return;
      }

      const result = await sendChatMessage({
        senderId,
        conversationId: String(conversationId),
        content,
        contentType,
        mediaUrl,
        mediaType,
        fileName,
        fileSize,
        replyToId,
        clientMessageId,
      });

      if (!result.wasDuplicate) {
        logger.info({
          event: 'chat.message.persisted.emit_start',
          socketId: socket.id,
          senderId,
          receiverId: result.receiverId,
          conversationId: result.conversationId,
          messageId: result.message.id,
          clientMessageId: result.message.clientMessageId,
          transport: socket.conn.transport.name,
        });
        emitRealtimeEnvelopes(result.realtimeEnvelopes);
      }
      acknowledge?.({ ok: true, message: result.message });

      // Record messaging activity and update streak (non-blocking)
      recordActivity(senderId, 'message', 1, { sourceId: result.message.id }).catch(console.error);
      updateEngagementStreak(senderId, 'messaging').catch(console.error);
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) {
        socket.emit('error', safety.body);
        acknowledge?.({ ok: false, ...safety.body });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      if (
        message === 'Content or media is required' ||
        message === 'Conversation not found' ||
        message === 'Reply target is invalid for this conversation'
      ) {
        failSend(message);
        return;
      }
      console.error('chat:send_message error:', error);
      failSend('Failed to send message');
    }
  });

  // Typing indicator
  socket.on('chat:typing', async ({ conversationId, isTyping }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    const targetConversationId = typeof conversationId === 'string' ? conversationId : '';
    if (!targetConversationId) return;

    try {
      const peerId = await getConversationPeerId(targetConversationId, userId);
      if (!peerId) return;
      await assertUsersCanInteract(userId, peerId, 'typing indicator');
      void warmChatSendPath(targetConversationId, userId).catch(() => undefined);
      if (!(await allowChatTypingBroadcast(userId, targetConversationId))) return;

      const payload = {
        conversationId: targetConversationId,
        userId,
        isTyping: Boolean(isTyping),
        serverEmittedAtMs: Date.now(),
      };

      // Socket.IO treats an array of rooms as a union, so a recipient joined
      // to both the chat room and their personal room receives this once.
      io.to([`chat:${targetConversationId}`, `user:${peerId}`])
        .except(socket.id)
        .emit('chat:user_typing', payload);
      logger.debug({
        event: 'chat.typing.emit',
        socketId: socket.id,
        userId,
        peerId,
        conversationId: targetConversationId,
        isTyping: Boolean(isTyping),
      });
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) socket.emit('error', safety.body);
      else console.error('chat:typing error:', error);
    }
  });

  // Mark messages as read
  socket.on('chat:mark_read', async ({ conversationId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const now = new Date();

      const senderId = await getConversationPeerId(conversationId, userId);
      if (!senderId) return;
      await assertUsersCanInteract(userId, senderId, 'read receipt');

      // Update unread messages for unread counts; premium only controls who can see receipts.
      const updated = await prisma.messages.updateMany({
        where: {
          conversationId,
          receiverId: userId,
          status: { not: 'READ' },
        },
        data: {
          status: 'READ',
          readAt: now,
          updatedAt: now,
        },
      });

      const senderCanUseReadReceipts = await getReadReceiptVisibilityCached(senderId);
      if (
        shouldNotifySenderAboutReadReceipt({
          updatedCount: updated.count,
          senderCanUseReadReceipts,
        })
      ) {
        emitToUser(senderId, 'chat:messages_read', {
          conversationId,
          readBy: userId,
          readAt: now,
        });
      }
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) socket.emit('error', safety.body);
      else console.error('chat:mark_read error:', error);
    }
  });

  // Delete message
  socket.on('chat:delete_message', async ({ messageId, forEveryone }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 128) return;

    try {
      const message = await prisma.messages.findUnique({
        where: { id: messageId },
      });

      const deleteForEveryone = forEveryone === true;
      const isParticipant = message && (message.senderId === userId || message.receiverId === userId);
      if (!message || !isParticipant || (deleteForEveryone && message.senderId !== userId)) {
        socket.emit('error', { message: 'Cannot delete this message' });
        return;
      }

      const actualConversationId = message.conversationId;
      if (deleteForEveryone) {
        await prisma.messages.update({
          where: { id: messageId },
          data: { isDeleted: true, content: '', updatedAt: new Date() },
        });
      } else {
        await prisma.messages.updateMany({
          where: {
            id: messageId,
            NOT: { hiddenForUserIds: { has: userId } },
          },
          data: { hiddenForUserIds: { push: userId }, updatedAt: new Date() },
        });
      }

      const target = deleteForEveryone ? io.to(`chat:${actualConversationId}`) : io.to(`user:${userId}`);
      target.emit('chat:message_deleted', {
        messageId,
        conversationId: actualConversationId,
        deletedBy: userId,
        forEveryone: deleteForEveryone,
      });
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) socket.emit('error', safety.body);
      else console.error('chat:delete_message error:', error);
    }
  });

  // Edit message
  socket.on('chat:edit_message', async ({ messageId, content }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const message = await prisma.messages.findUnique({
        where: { id: messageId },
      });

      if (!message || message.senderId !== userId) {
        socket.emit('error', { message: 'Cannot edit this message' });
        return;
      }
      if (message.isDeleted) {
        socket.emit('error', { message: 'Cannot edit this message' });
        return;
      }
      await assertUsersCanInteract(userId, message.receiverId, 'message edit');

      const editedAt = new Date();
      await prisma.messages.update({
        where: { id: messageId },
        data: { content, editedAt, updatedAt: editedAt },
      });

      // Broadcast edit
      io.to(`chat:${message.conversationId}`).emit('chat:message_edited', {
        messageId,
        conversationId: message.conversationId,
        content,
        editedAt,
      });
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) socket.emit('error', safety.body);
      else console.error('chat:edit_message error:', error);
    }
  });

  // React to message
  socket.on('chat:react', async ({ messageId, emoji }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (!emoji) {
      socket.emit('error', { message: 'Emoji is required' });
      return;
    }

    try {
      const message = await prisma.messages.findUnique({
        where: { id: messageId },
        select: { id: true, conversationId: true, senderId: true, receiverId: true, isDeleted: true },
      });
      if (!message || message.isDeleted || (message.senderId !== userId && message.receiverId !== userId)) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }
      const conversationId = message.conversationId;
      const peerId = message.senderId === userId ? message.receiverId : message.senderId;
      await assertUsersCanInteract(userId, peerId, 'message reaction');

      const existingReaction = await prisma.message_reactions.findUnique({
        where: {
          messageId_userId: { messageId, userId },
        },
      });

      let action: string;

      if (existingReaction) {
        if (existingReaction.emoji === emoji) {
          await prisma.message_reactions.delete({
            where: { id: existingReaction.id },
          });
          action = 'removed';
        } else {
          await prisma.message_reactions.update({
            where: { id: existingReaction.id },
            data: { emoji },
          });
          action = 'updated';
        }
      } else {
        await prisma.message_reactions.create({
          data: { id: randomUUID(), messageId, userId, emoji },
        });
        action = 'added';
      }

      // Broadcast reaction
      io.to(`chat:${conversationId}`).emit('chat:message_reaction', {
        messageId,
        conversationId,
        userId,
        emoji,
        action,
      });
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) socket.emit('error', safety.body);
      else console.error('chat:react error:', error);
    }
  });

  // Recipient acknowledges receipt of message(s) so the sender sees delivered ticks
  socket.on('chat:delivered', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    const payload = data && typeof data === 'object' ? data : {};
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
    if (!conversationId) return;

    try {
      const peerId = await getConversationPeerId(conversationId, userId);
      if (!peerId) return;
      await assertUsersCanInteract(userId, peerId, 'delivery receipt');

      const now = new Date();
      const updated = await prisma.messages.updateMany({
        where: {
          conversationId,
          receiverId: userId,
          status: 'SENT',
          isDeleted: false,
        },
        data: { status: 'DELIVERED', deliveredAt: now, updatedAt: now },
      });
      if (updated.count === 0) return;

      if (messageId) {
        emitToUser(peerId, 'chat:message_delivered', {
          messageId,
          conversationId,
          deliveredAt: now,
        });
      }
      emitToUser(peerId, 'chat:messages_delivered', {
        conversationId,
        deliveredTo: userId,
        deliveredAt: now,
      });
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) socket.emit('error', safety.body);
      else console.error('chat:delivered error:', error);
    }
  });

  // On-demand presence lookup, restricted to conversation partners and connections
  socket.on('user:check_status', async (data) => {
    const requesterId = getSocketUserId(socket);
    if (!requesterId) return;

    const payload = data && typeof data === 'object' ? data : {};
    const targetUserId = typeof payload.userId === 'string' ? payload.userId : '';
    if (!targetUserId || targetUserId === requesterId) return;

    try {
      await assertUsersCanInteract(requesterId, targetUserId, 'presence');
      const conversation = await prisma.conversations.findFirst({
        where: {
          OR: [
            { participant1Id: requesterId, participant2Id: targetUserId },
            { participant1Id: targetUserId, participant2Id: requesterId },
          ],
        },
        select: { id: true },
      });

      if (!conversation) {
        const connection = await prisma.connections.findFirst({
          where: {
            status: 'accepted',
            OR: [
              { requesterId, addresseeId: targetUserId },
              { requesterId: targetUserId, addresseeId: requesterId },
            ],
          },
          select: { id: true },
        });
        if (!connection) return;
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, isOnline: true, lastActiveAt: true },
      });
      if (!targetUser) return;

      const sharedPresence = await getSharedChatPresence(targetUserId);

      socket.emit('user:status', {
        userId: targetUser.id,
        isOnline: sharedPresence ?? Boolean(targetUser.isOnline),
        lastActiveAt: targetUser.lastActiveAt ? targetUser.lastActiveAt.toISOString() : null,
      });
    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (!safety) console.error('user:check_status error:', error);
    }
  });
}
