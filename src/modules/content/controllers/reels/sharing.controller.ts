import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { getIO } from "../../../../realtime/socket-registry";
import { notificationService } from "../../../notifications/services/notification.service";
import { recordAuthoritativeRecommendationOutcome } from "../../../discovery/services/recommendation-platform.service";
import { assertUsersCanInteract, enforceTrustTierLimit, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { randomUUID } from "crypto";
import { AuthRequest, isUniqueViolation } from "./support.controller";

export const shareReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { shareType, platform, recipientId } = req.body;

    const [reel, user] = await Promise.all([
      prisma.reels.findUnique({
        where: { id: reelId },
        select: { 
          id: true, 
          authorId: true,
          visibility: true,
          status: true,
          publishedAt: true,
          allowSharing: true, 
          sharesCount: true,
          title: true,
          caption: true,
          thumbnailUrl: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true },
      }),
    ]);

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (!reel.allowSharing) {
      res.status(403).json({ error: 'Sharing is disabled for this reel' });
      return;
    }

    let createdShare = false;
    let sharesCount = reel.sharesCount || 0;
    try {
      const result = await prisma.$transaction(async (tx) => {
        await tx.reel_shares.create({
          data: {
            reelId,
            userId,
            shareType: shareType || 'copy_link',
            platform,
            recipientId,
          },
        });

        const updatedReel = await tx.reels.update({
          where: { id: reelId },
          data: { sharesCount: { increment: 1 } },
          select: { sharesCount: true },
        });

        return { createdShare: true, sharesCount: updatedReel.sharesCount };
      });
      createdShare = result.createdShare;
      sharesCount = result.sharesCount;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const current = await prisma.reels.findUnique({
        where: { id: reelId },
        select: { sharesCount: true },
      });
      sharesCount = current?.sharesCount || 0;
    }

    const io = getIO();
    if (io) {
      io.to(`reel:${reelId}`).emit('reel:engagement_update', { 
        reelId, 
        type: 'share',
        sharesCount 
      });
    }

    // Notify reel author about the share
    if (createdShare && reel.authorId !== userId && user) {
      notificationService.notifyReelShare(
        reel.authorId,
        userId,
        user.name || user.username,
        reelId
      );
    }

    if (createdShare) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'SHARE', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.json({ success: true, sharesCount });
  } catch (error) {
    console.error('shareReel error:', error);
    res.status(500).json({ error: 'Failed to share reel' });
  }
};

// Share reel in chat (send to specific user)
export const shareReelInChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const recipientId = ensureString(req.body?.recipientId);
    const accompanyingMessage = typeof req.body?.message === 'string'
      ? req.body.message.trim().slice(0, 2000)
      : '';

    if (!recipientId) {
      res.status(400).json({ error: 'recipientId is required' });
      return;
    }

    if (recipientId === userId) {
      res.status(400).json({ error: 'Cannot share a reel with yourself' });
      return;
    }

    const [reel, sender, recipient] = await Promise.all([
      prisma.reels.findUnique({
        where: { id: reelId },
        select: {
          id: true,
          authorId: true,
          visibility: true,
          status: true,
          publishedAt: true,
          title: true,
          caption: true,
          thumbnailUrl: true,
          hlsUrl: true,
          videoUrl: true,
          allowSharing: true,
          sharesCount: true,
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
        },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, username: true, profileImage: true, isVerified: true },
      }),
      prisma.user.findUnique({
        where: { id: recipientId },
        select: { id: true, name: true, username: true },
      }),
    ]);

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (!reel.allowSharing) {
      res.status(403).json({ error: 'Sharing is disabled for this reel' });
      return;
    }

    if (!recipient) {
      res.status(404).json({ error: 'Recipient not found' });
      return;
    }

    if (!(await canViewReel(reel, recipientId))) {
      res.status(403).json({ error: 'Recipient cannot access this reel' });
      return;
    }

    await assertUsersCanInteract(userId, recipientId, 'reel share');
    await enforceTrustTierLimit(userId, 'dm');

    // Get or create conversation
    let conversation = await prisma.conversations.findFirst({
      where: {
        OR: [
          { participant1Id: userId, participant2Id: recipientId },
          { participant1Id: recipientId, participant2Id: userId },
        ],
      },
    });

    if (!conversation) {
      conversation = await prisma.conversations.create({
        data: {
          participant1Id: userId,
          participant2Id: recipientId,
        },
      });
    }

    // Create message with reel content
    const reelData = {
      reelId: reel.id,
      title: reel.title,
      caption: reel.caption,
      thumbnailUrl: reel.thumbnailUrl,
      author: reel.users,
    };

    const now = new Date();
    const transactionResult = await prisma.$transaction(async (tx) => {
      const chatMessage = await tx.messages.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          senderId: userId,
          receiverId: recipientId,
          content: JSON.stringify({
            reelId: reel.id,
            ...(accompanyingMessage ? { message: accompanyingMessage } : {}),
          }),
          contentType: 'reel',
          mediaUrl: reel.thumbnailUrl,
          mediaType: 'reel',
          status: 'SENT',
          createdAt: now,
          updatedAt: now,
        },
      });

      await tx.conversations.update({
        where: { id: conversation.id },
        data: { lastMessageAt: now },
      });

      // A user contributes at most one share to a reel's public counter, but
      // can still send that reel to any number of conversations. Skipping the
      // duplicate keeps repeated chat sends successful without inflating the
      // counter or tripping the (reelId, userId) unique constraint.
      const shareInsert = await tx.reel_shares.createMany({
        data: [{
          reelId,
          userId,
          shareType: 'chat',
          recipientId,
        }],
        skipDuplicates: true,
      });

      const createdShare = shareInsert.count === 1;
      const sharesCount = createdShare
        ? (await tx.reels.update({
            where: { id: reelId },
            data: { sharesCount: { increment: 1 } },
            select: { sharesCount: true },
          })).sharesCount
        : (await tx.reels.findUnique({
            where: { id: reelId },
            select: { sharesCount: true },
          }))?.sharesCount || 0;

      return { chatMessage, createdShare, sharesCount };
    });
    const { chatMessage, createdShare, sharesCount } = transactionResult;

    // Send real-time message to recipient
    const io = getIO();
    if (io) {
      const messagePayload = {
        id: chatMessage.id,
        conversationId: conversation.id,
        senderId: userId,
        receiverId: recipientId,
        content: chatMessage.content,
        contentType: 'reel',
        mediaUrl: chatMessage.mediaUrl,
        mediaType: 'reel',
        reelData: { ...reel, reelId: reel.id },
        status: 'SENT',
        createdAt: chatMessage.createdAt.toISOString(),
        sender,
      };

      // Send to conversation room (match format expected by frontend: { conversationId, message })
      io.to(`chat:${conversation.id}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });

      // Send notification to recipient
      io.to(`user:${recipientId}`).emit('chat:notification', {
        conversationId: conversation.id,
        message: messagePayload,
      });

      // Update reel engagement
      io.to(`reel:${reelId}`).emit('reel:engagement_update', {
        reelId,
        type: 'share',
        sharesCount,
      });
    }

    // Notify reel author about the share
    if (createdShare && reel.authorId !== userId && sender) {
      notificationService.notifyReelShare(
        reel.authorId,
        userId,
        sender.name || sender.username,
        reelId
      );
    }

    if (createdShare) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'SHARE', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.json({
      success: true,
      message: {
        id: chatMessage.id,
        conversationId: conversation.id,
        reelData,
      },
      sharesCount,
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('shareReelInChat error:', error);
    res.status(500).json({ error: 'Failed to share reel in chat' });
  }
};
