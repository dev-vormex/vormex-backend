import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prismaRead, prisma } from "../../../../config/prisma";
import { canViewPost } from "../../../../shared/utils/access-control.util";
import { enforceTrustTierLimit, assertUsersCanInteract, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { notificationService } from "../../../notifications/services/notification.service";
import { recordActivity } from "../../../engagement/services/activity.service";
import { recordAuthoritativeRecommendationOutcome } from "../../../discovery/services/recommendation-platform.service";
import { AuthRequest, FEED_REALTIME_ROOM, feedCacheTags, getPostRealtimeRooms } from "./support.controller";

// Create comment
export const createComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const { content, parentId, mentions } = req.body || {};

    if (!postId || !content || typeof content !== 'string') {
      res.status(400).json({ error: 'Post ID and content are required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    await enforceTrustTierLimit(userId, 'comment');

    if (parentId) {
      const parentComment = await prismaRead.post_comments.findFirst({
        where: { id: String(parentId), postId },
        select: { id: true, authorId: true },
      });
      if (!parentComment) {
        res.status(400).json({ error: 'Parent comment is invalid for this post' });
        return;
      }
      await assertUsersCanInteract(userId, parentComment.authorId, 'comment reply');
    }

    const { comment, mapped } = await prisma.$transaction(async (tx) => {
      const nextComment = await tx.post_comments.create({
        data: {
          postId,
          authorId: userId,
          parentId: parentId || null,
          content: content.trim(),
        },
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
              isVerified: true,
              profileBadgeStyle: true,
              identityTrustLevel: true,
            },
          },
          comment_likes: {
            where: { userId },
            select: { userId: true },
          },
          _count: { select: { other_post_comments: true } },
        },
      });

      const nextCommentsCount = await tx.post_comments.count({ where: { postId, parentId: null } });
      await tx.post.update({
        where: { id: postId },
        data: { commentsCount: nextCommentsCount },
      });

      const commentWithRelations = nextComment as typeof nextComment & {
        users: unknown;
        _count: { other_post_comments: number };
      };
      const mappedComment = {
        id: nextComment.id,
        postId: nextComment.postId,
        parentId: nextComment.parentId,
        authorId: nextComment.authorId,
        author: commentWithRelations.users,
        content: nextComment.content,
        contentType: 'text/plain',
        mentions: mentions || [],
        likesCount: nextComment.likesCount,
        replyCount: commentWithRelations._count.other_post_comments,
        isLiked: false,
        createdAt: nextComment.createdAt,
        updatedAt: nextComment.updatedAt,
      };

      const envelopes: Array<Record<string, unknown>> = [
        {
          event: 'comment:created',
          rooms: [`post:${postId}`],
          payload: {
            postId,
            comment: mappedComment,
            commentsCount: nextCommentsCount,
          },
        },
      ];
      if (String(post.visibility || 'public').toLowerCase() === 'public') {
        envelopes.push({
          event: 'comment:created',
          rooms: [FEED_REALTIME_ROOM],
          payload: {
            postId,
            commentsCount: nextCommentsCount,
          },
        });
      }

      if (post.authorId !== userId) {
        envelopes.push({
          event: 'notification:comment',
          users: [post.authorId],
          payload: {
            postId,
            comment: mappedComment,
            commentsCount: nextCommentsCount,
          },
        });
      }

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: nextComment.id,
        eventType: 'post.comment.created',
        envelopes: envelopes as any,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.comment.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      return {
        comment: nextComment,
        commentsCount: nextCommentsCount,
        mapped: mappedComment,
      };
    });

    if (post.authorId !== userId) {
      notificationService.notifyPostComment(
        post.authorId,
        userId,
        ((comment as typeof comment & { users: { name: string | null } }).users?.name) ?? 'Someone',
        postId,
        mapped.id,
        content.trim()
      ).catch(console.error);
    }

    // Record comment activity (non-blocking)
    recordActivity(userId, 'comment', 1, { sourceId: mapped.id }).catch(console.error);
    void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'POST', entityId: postId, eventType: 'COMMENT', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.status(201).json(mapped);
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

// Toggle comment like
export const toggleCommentLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const commentId = ensureString(req.params.commentId);

    if (!postId || !commentId) {
      res.status(400).json({ error: 'Post ID and comment ID are required' });
      return;
    }

    const comment = await prismaRead.post_comments.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        postId: true,
        authorId: true,
        posts: {
          select: { id: true, authorId: true, visibility: true, isActive: true },
        },
      },
    });

    if (!comment || comment.postId !== postId || !(await canViewPost(comment.posts, userId))) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    await assertUsersCanInteract(userId, comment.authorId, 'comment reaction');

    const existing = await prismaRead.comment_likes.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });

    const { liked, likesCount } = await prisma.$transaction(async (tx) => {
      let nextLiked = false;
      if (existing) {
        await tx.comment_likes.delete({
          where: { commentId_userId: { commentId, userId } },
        });
      } else {
        await tx.comment_likes.create({
          data: { commentId, userId },
        });
        nextLiked = true;
      }

      const nextLikesCount = await tx.comment_likes.count({ where: { commentId } });
      await tx.post_comments.update({
        where: { id: commentId },
        data: { likesCount: nextLikesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: commentId,
        eventType: 'post.comment.like',
        envelopes: [
          {
            event: 'comment:liked',
            rooms: [`post:${postId}`],
            payload: {
              commentId,
              postId,
              userId,
              liked: nextLiked,
              likesCount: nextLikesCount,
            },
          },
        ],
      });

      return { liked: nextLiked, likesCount: nextLikesCount };
    });

    res.json({ isLiked: liked, liked, likesCount });
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

// Delete comment (author only)
export const deleteComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const commentId = ensureString(req.params.commentId);

    if (!postId || !commentId) {
      res.status(400).json({ error: 'Post ID and Comment ID are required' });
      return;
    }

    const comment = await prismaRead.post_comments.findUnique({
      where: { id: commentId },
      select: { authorId: true, postId: true, parentId: true },
    });

    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    if (comment.postId !== postId) {
      res.status(400).json({ error: 'Comment does not belong to this post' });
      return;
    }

    if (comment.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own comments' });
      return;
    }

    const postRecord = await prismaRead.post.findUnique({
      where: { id: postId },
      select: { authorId: true, visibility: true },
    });

    const commentsCount = await prisma.$transaction(async (tx) => {
      await tx.post_comments.delete({ where: { id: commentId } });

      const nextCommentsCount = await tx.post_comments.count({ where: { postId, parentId: null } });
      await tx.post.update({
        where: { id: postId },
        data: { commentsCount: nextCommentsCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: commentId,
        eventType: 'post.comment.deleted',
        envelopes: [
          {
            event: 'comment:deleted',
            rooms: getPostRealtimeRooms(postId, postRecord?.visibility),
            payload: { postId, commentId, commentsCount: nextCommentsCount },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.comment.deleted.cache.invalidate',
        tags: feedCacheTags(`feed:${postRecord?.authorId || userId}`, `user:${postRecord?.authorId || userId}`),
      });

      return nextCommentsCount;
    });

    res.json({ success: true, commentsCount });
  } catch (error) {
    console.error('deleteComment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};
