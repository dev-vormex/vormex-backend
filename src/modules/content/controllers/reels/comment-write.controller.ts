import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { enforceTrustTierLimit, assertUsersCanInteract, shouldNotifyUser, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { getIO } from "../../../../realtime/socket-registry";
import { notificationService } from "../../../notifications/services/notification.service";
import { AuthRequest, normalizeMentionUsernames, reelCommentAuthorSelect, mapReelCommentAuthor } from "./support.controller";

export const createComment = async (req: AuthRequest, res: Response): Promise<void> => {
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
    const { content, parentId, mentions } = req.body;

    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        id: true,
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        allowComments: true,
      },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (!reel.allowComments) {
      res.status(403).json({ error: 'Comments are disabled for this reel' });
      return;
    }

    await enforceTrustTierLimit(userId, 'comment');
    await assertUsersCanInteract(userId, reel.authorId, 'comment');

    if (parentId) {
      const parentComment = await prisma.reel_comments.findFirst({
        where: { id: String(parentId), reelId },
        select: { id: true, authorId: true },
      });
      if (!parentComment) {
        res.status(400).json({ error: 'Parent comment is invalid for this reel' });
        return;
      }
      await assertUsersCanInteract(userId, parentComment.authorId, 'comment reply');
    }

    const normalizedMentions = normalizeMentionUsernames(content, mentions);

    const { comment, commentsCount } = await prisma.$transaction(async (tx) => {
      const createdComment = await tx.reel_comments.create({
        data: {
          reelId,
          authorId: userId,
          content: content.trim(),
          parentId: parentId || null,
          mentions: normalizedMentions,
        },
        include: {
          users: { select: reelCommentAuthorSelect },
          reel_comments: parentId ? {
            select: {
              authorId: true,
              users: {
                select: { name: true, username: true },
              },
            },
          } : false,
        },
      });

      if (parentId) {
        await tx.reel_comments.update({
          where: { id: parentId },
          data: { repliesCount: { increment: 1 } },
        });
        const current = await tx.reels.findUnique({
          where: { id: reelId },
          select: { commentsCount: true },
        });
        return { comment: createdComment, commentsCount: current?.commentsCount || 0 };
      }

      const updatedReel = await tx.reels.update({
        where: { id: reelId },
        data: { commentsCount: { increment: 1 } },
        select: { commentsCount: true },
      });
      return { comment: createdComment, commentsCount: updatedReel.commentsCount };
    });

    const commentAuthor = mapReelCommentAuthor(comment.users);
    const parentComment = comment.reel_comments as
      | { authorId: string; users: { name: string | null; username: string } | null }
      | null;

    const io = getIO();
    if (io) {
      // Broadcast to reel room for real-time updates
      io.to(`reel:${reelId}`).emit('reel:engagement_update', {
        reelId,
        type: 'comment',
        comment: {
          id: comment.id,
          author: commentAuthor,
          content: comment.content,
          parentId: comment.parentId,
        },
        commentsCount,
      });
    }

    // Send notification to reel author (if not commenting on own reel)
    if (reel.authorId !== userId) {
      notificationService.notifyReelComment(
        reel.authorId,
        userId,
        commentAuthor.name || commentAuthor.username,
        reelId,
        comment.id,
        comment.content
      );
    }

    // Send notification to parent comment author (if replying)
    if (parentId && parentComment && parentComment.authorId !== userId) {
      notificationService.notifyReelCommentReply(
        parentComment.authorId,
        userId,
        commentAuthor.name || commentAuthor.username,
        reelId,
        comment.id,
        parentId,
        comment.content
      );
    }

    // Send notifications for @mentions
    if (normalizedMentions.length > 0) {
      const mentionedUsers = await prisma.user.findMany({
        where: {
          isBanned: false,
          OR: normalizedMentions.map((username) => ({
            username: { equals: username, mode: 'insensitive' },
          })),
        },
        select: { id: true, username: true },
      });

      for (const mentionedUser of mentionedUsers) {
        // A mention must not become a side channel around the reel's own visibility or blocks.
        if (
          mentionedUser.id !== userId
          && await canViewReel(reel, mentionedUser.id)
          && await shouldNotifyUser(userId, mentionedUser.id)
        ) {
          notificationService.notifyMention(
            mentionedUser.id,
            userId,
            commentAuthor.name || commentAuthor.username,
            'reel_comment',
            reelId,
            comment.content,
            {
              commentId: comment.id,
              parentCommentId: comment.parentId || undefined,
            }
          );
        }
      }
    }

    res.status(201).json({
      id: comment.id,
      reelId: comment.reelId,
      parentId: comment.parentId,
      author: commentAuthor,
      content: comment.content,
      mentions: comment.mentions,
      likesCount: 0,
      repliesCount: 0,
      isLiked: false,
      isPinned: false,
      isAuthorHeart: false,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('createComment error:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
};

export const toggleCommentLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const commentId = ensureString(req.params.commentId);
    if (!commentId) {
      res.status(400).json({ error: 'Comment ID is required' });
      return;
    }

    const existing = await prisma.reel_comment_likes.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });

    const comment = await prisma.reel_comments.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        reelId: true,
        authorId: true,
        reels: {
          select: { authorId: true, visibility: true, status: true, publishedAt: true },
        },
      },
    });

    if (!comment || comment.reelId !== ensureString(req.params.reelId) || !(await canViewReel(comment.reels, userId))) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    await assertUsersCanInteract(userId, comment.authorId, 'comment reaction');

    let liked = false;
    if (existing) {
      await prisma.reel_comment_likes.delete({
        where: { commentId_userId: { commentId, userId } },
      });
    } else {
      await prisma.reel_comment_likes.create({
        data: { commentId, userId },
      });
      liked = true;
    }

    const likesCount = await prisma.reel_comment_likes.count({ where: { commentId } });
    await prisma.reel_comments.update({
      where: { id: commentId },
      data: { likesCount },
    });

    res.json({ liked, likesCount });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('toggleCommentLike error:', error);
    res.status(500).json({ error: 'Failed to toggle comment like' });
  }
};

export const deleteComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    const commentId = ensureString(req.params.commentId);
    if (!reelId || !commentId) {
      res.status(400).json({ error: 'Reel ID and Comment ID are required' });
      return;
    }

    const comment = await prisma.reel_comments.findUnique({
      where: { id: commentId },
      select: { authorId: true, reelId: true, parentId: true },
    });

    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true },
    });

    if (!reel || comment.reelId !== reelId) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    if (comment.authorId !== userId && reel.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own comments' });
      return;
    }

    await prisma.reel_comments.delete({ where: { id: commentId } });

    if (comment.parentId) {
      await prisma.reel_comments.update({
        where: { id: comment.parentId },
        data: { repliesCount: { decrement: 1 } },
      });
    }

    const commentsCount = await prisma.reel_comments.count({
      where: { reelId, parentId: null },
    });
    await prisma.reels.update({
      where: { id: reelId },
      data: { commentsCount },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('deleteComment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

export const heartComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    const commentId = ensureString(req.params.commentId);
    if (!reelId || !commentId) {
      res.status(400).json({ error: 'Reel ID and Comment ID are required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true },
    });

    if (!reel || reel.authorId !== userId) {
      res.status(403).json({ error: 'Only the reel author can heart comments' });
      return;
    }

    const comment = await prisma.reel_comments.findUnique({
      where: { id: commentId },
      select: { isAuthorHeart: true, reelId: true },
    });

    if (!comment || comment.reelId !== reelId) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    await prisma.reel_comments.update({
      where: { id: commentId },
      data: { isAuthorHeart: !comment.isAuthorHeart },
    });

    res.json({ isAuthorHeart: !comment.isAuthorHeart });
  } catch (error) {
    console.error('heartComment error:', error);
    res.status(500).json({ error: 'Failed to heart comment' });
  }
};
