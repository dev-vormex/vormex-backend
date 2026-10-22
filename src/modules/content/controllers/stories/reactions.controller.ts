import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewStory } from "../../../../shared/utils/access-control.util";
import { assertUsersCanInteract, enforceTrustTierLimit, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import crypto from "crypto";
import { getIO } from "../../../../realtime/socket-registry";
import { AuthRequest, sendStoryUnavailable, getStoryReactionsModel, DEFAULT_STORY_REACTION, invalidateStoryFeedCaches } from "./support.controller";

// React to story - also sends as DM to story owner
export const reactToStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const storyId = ensureString(req.params.storyId);
    const { reactionType } = req.body; // emoji like "❤️", "🔥", etc.
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }
    const story = await prisma.stories.findFirst({
      where: { id: storyId, expiresAt: { gt: new Date() } },
      include: { users: { select: { id: true, name: true, username: true } } },
    });
    if (!story) {
      sendStoryUnavailable(res);
      return;
    }
    if (!(await canViewStory(story, userId))) {
      sendStoryUnavailable(res);
      return;
    }

    const reactionModel = getStoryReactionsModel();
    const normalizedReaction = typeof reactionType === 'string' && reactionType.trim().length > 0
      ? reactionType.trim()
      : DEFAULT_STORY_REACTION;
    const existingReaction = await reactionModel.findUnique({
      where: { storyId_userId: { storyId, userId } },
      select: { reactionType: true },
    });
    
    // Don't send DM to self
    if (story.authorId !== userId) {
      await assertUsersCanInteract(userId, story.authorId, 'story reaction');
      await enforceTrustTierLimit(userId, 'dm');

      // Get or create conversation with story owner
      let conversation = await prisma.conversations.findFirst({
        where: {
          OR: [
            { participant1Id: userId, participant2Id: story.authorId },
            { participant1Id: story.authorId, participant2Id: userId },
          ],
        },
      });
      
      if (!conversation) {
        conversation = await prisma.conversations.create({
          data: {
            participant1Id: userId,
            participant2Id: story.authorId,
          },
        });
      }
      
      // Get sender info
      const sender = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, username: true, profileImage: true },
      });
      
      // Create message with story reaction
      const emoji = normalizedReaction;
      const storyData = {
        storyId: story.id,
        mediaUrl: story.mediaUrl,
        mediaType: story.mediaType,
        thumbnailUrl: story.thumbnailUrl,
        textContent: story.textContent,
        backgroundColor: story.backgroundColor,
        expiresAt: story.expiresAt.toISOString(),
        reaction: emoji,
      };
      
      const chatMessage = await prisma.messages.create({
        data: {
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          senderId: userId,
          receiverId: story.authorId,
          content: `Reacted ${emoji} to your story`,
          contentType: 'story_reaction',
          mediaUrl: story.thumbnailUrl || story.mediaUrl,
          mediaType: 'story',
          fileName: JSON.stringify(storyData),
          status: 'SENT',
          updatedAt: new Date(),
        },
      });
      
      // Update conversation lastMessageAt
      await prisma.conversations.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      
      // Send real-time message to recipient
      const io = getIO();
      if (io) {
        const messagePayload = {
          id: chatMessage.id,
          conversationId: conversation.id,
          senderId: userId,
          receiverId: story.authorId,
          content: chatMessage.content,
          contentType: 'story_reaction',
          mediaUrl: chatMessage.mediaUrl,
          mediaType: 'story',
          storyData,
          story: {
            id: story.id,
            mediaUrl: story.mediaUrl,
            mediaType: story.mediaType,
            thumbnailUrl: story.thumbnailUrl,
            textContent: story.textContent,
            backgroundColor: story.backgroundColor,
            expiresAt: story.expiresAt.toISOString(),
            available: true,
          },
          status: 'SENT',
          createdAt: chatMessage.createdAt.toISOString(),
          sender,
        };
        
        io.to(`chat:${conversation.id}`).emit('chat:new_message', {
          conversationId: conversation.id,
          message: messagePayload,
        });
        io.to(`user:${story.authorId}`).emit('chat:new_message', {
          conversationId: conversation.id,
          message: messagePayload,
        });
      }
    }
    
    await reactionModel.upsert({
      where: { storyId_userId: { storyId, userId } },
      create: { storyId, userId, reactionType: normalizedReaction },
      update: { reactionType: normalizedReaction },
    });
    const reactionsCount = await reactionModel.count({ where: { storyId } });
    await prisma.stories.update({
      where: { id: storyId },
      data: { reactionsCount },
    });
    await invalidateStoryFeedCaches(`stories:${userId}`, `stories:${story.authorId}`);
    res.json({
      success: true,
      message: existingReaction ? 'Reaction updated' : 'Reaction added',
      reactionType: normalizedReaction,
      reactionsCount,
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('React to story error:', error);
    res.status(500).json({ error: 'Failed to react to story' });
  }
};

// Remove story reaction
export const removeStoryReaction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }
    const story = await prisma.stories.findFirst({ where: { id: storyId } });
    if (!story) {
      sendStoryUnavailable(res);
      return;
    }
    if (!(await canViewStory(story, userId))) {
      sendStoryUnavailable(res);
      return;
    }

    const reactionModel = getStoryReactionsModel();
    await reactionModel.deleteMany({ where: { storyId, userId } });
    const newCount = await reactionModel.count({ where: { storyId } });
    await prisma.stories.update({
      where: { id: storyId },
      data: { reactionsCount: newCount },
    });
    await invalidateStoryFeedCaches(`stories:${userId}`, `stories:${story.authorId}`);
    res.json({ message: 'Reaction removed', reactionsCount: newCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
};
