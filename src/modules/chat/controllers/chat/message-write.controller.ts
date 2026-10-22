import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { sendChatMessage } from "../../services/chat-message.service";
import { emitRealtimeEnvelopes } from "../../../../infrastructure/realtime/emitter";
import { safetyErrorResponse, assertUsersCanInteract } from "../../../safety/services/trust-safety.service";
import { prisma, prismaRead } from "../../../../config/prisma";
import type { RealtimeEnvelope } from "../../../../infrastructure/realtime/channels";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { randomUUID } from "crypto";
import { AuthRequest, messageCacheTags, invalidateChatCaches, sendControllerError, userSelect, getChatPremiumVisibilityByUserIds, buildChatUserIdentity, getReadReceiptVisibility, mapMessagePayload } from "./support.controller";

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
    const forEveryone = req.body?.forEveryone === true;

    const message = await prisma.messages.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const isParticipant = message.senderId === req.user.userId || message.receiverId === req.user.userId;
    if (!isParticipant || (forEveryone && message.senderId !== req.user.userId)) {
      res.status(403).json({ error: 'Not authorized to delete this message' });
      return;
    }

    const realtimeEnvelopes: RealtimeEnvelope[] = [
      {
        event: 'chat:message_deleted',
        ...(forEveryone
          ? { rooms: [`chat:${message.conversationId}`] }
          : { users: [req.user.userId] }),
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
        await tx.messages.updateMany({
          where: {
            id: messageId,
            NOT: { hiddenForUserIds: { has: req.user!.userId } },
          },
          data: { hiddenForUserIds: { push: req.user!.userId }, updatedAt: new Date() },
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
    sendControllerError(res, error, 'Failed to delete message');
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
    await assertUsersCanInteract(req.user.userId, message.receiverId, 'message edit');

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
    sendControllerError(res, error, 'Failed to edit message');
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
    const reactionPeerId = message.senderId === req.user.userId ? message.receiverId : message.senderId;
    await assertUsersCanInteract(req.user.userId, reactionPeerId, 'message reaction');

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
    sendControllerError(res, error, 'Failed to add reaction');
  }
};
