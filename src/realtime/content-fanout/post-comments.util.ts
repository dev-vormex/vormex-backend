import { prisma } from "../../config/prisma";
import { canViewPost } from "../../shared/utils/access-control.util";
import { enforceTrustTierLimit, assertUsersCanInteract } from "../../modules/safety/services/trust-safety.service";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../infrastructure/outbox/helpers";
import { postCommentAuthorSelect, feedRealtimeRoom } from "./support.util";

export async function createPostCommentWithFanout(
  postId: string,
  userId: string,
  content: string,
  parentId?: string,
  mentions?: string[]
): Promise<{ mappedComment: Record<string, unknown>; commentsCount: number } | null> {
  const author = await prisma.user.findUnique({
    where: { id: userId },
    select: postCommentAuthorSelect,
  });

  return prisma.$transaction(
    async (tx) => {
      const post = await tx.post.findFirst({
        where: { id: postId, isActive: true },
        select: { id: true, authorId: true, visibility: true, isActive: true },
      });

      if (!post || !(await canViewPost(post, userId, tx as any))) {
        return null;
      }

      await enforceTrustTierLimit(userId, 'comment');

      if (parentId) {
        const parentComment = await tx.post_comments.findFirst({
          where: { id: parentId, postId },
          select: { id: true, authorId: true },
        });
        if (!parentComment) {
          throw new Error('POST_COMMENT_PARENT_NOT_FOUND');
        }
        await assertUsersCanInteract(userId, parentComment.authorId, 'comment reply');
      }

      const comment = await tx.post_comments.create({
        data: {
          postId,
          authorId: userId,
          parentId: parentId || null,
          content: content.trim(),
        },
      });

      const commentsCount = await tx.post_comments.count({
        where: { postId, parentId: null },
      });

      await tx.post.update({
        where: { id: postId },
        data: { commentsCount },
      });

      const mappedComment = {
        id: comment.id,
        postId: comment.postId,
        parentId: comment.parentId,
        authorId: comment.authorId,
        author: author || {
          id: userId,
          username: 'unknown',
          name: 'Unknown User',
          profileImage: null,
          headline: null,
        },
        content: comment.content,
        contentType: 'text/plain',
        mentions: mentions || [],
        likesCount: comment.likesCount,
        replyCount: 0,
        isLiked: false,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      };
      const postRooms =
        String(post.visibility || '').toLowerCase() === 'public'
          ? [feedRealtimeRoom, `post:${postId}`]
          : [`post:${postId}`];

      const envelopes: Array<Record<string, unknown>> = [
        {
          event: 'comment:created',
          rooms: postRooms,
          payload: {
            postId,
            comment: mappedComment,
            commentsCount,
          },
        },
      ];

      if (post.authorId !== userId) {
        envelopes.push({
          event: 'notification:comment',
          users: [post.authorId],
          payload: {
            postId,
            comment: mappedComment,
            commentsCount,
          },
        });
      }

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: comment.id,
        eventType: 'post.comment.created.fanout',
        envelopes: envelopes as any,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.comment.cache.invalidate',
        tags: ['feed:global', `feed:${post.authorId}`, `user:${post.authorId}`],
      });

      return { mappedComment, commentsCount };
    },
    {
      maxWait: 10_000,
      timeout: 10_000,
    }
  );
}
