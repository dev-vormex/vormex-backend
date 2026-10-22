import { prisma } from "../../config/prisma";
import { canViewReel } from "../../shared/utils/access-control.util";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../infrastructure/outbox/helpers";
import { reelCommentAuthorSelect } from "./support.util";

export async function toggleReelLikeWithFanout(
  reelId: string,
  userId: string
): Promise<{ liked: boolean; likesCount: number } | null> {
  return prisma.$transaction(
    async (tx) => {
      const reel = await tx.reels.findUnique({
        where: { id: reelId },
        select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true },
      });

      if (!reel || !(await canViewReel(reel, userId, {}, tx as any))) {
        return null;
      }

      const existingLike = await tx.reel_likes.findUnique({
        where: { reelId_userId: { reelId, userId } },
      });

      let liked = false;
      if (existingLike) {
        await tx.reel_likes.delete({
          where: { reelId_userId: { reelId, userId } },
        });
      } else {
        await tx.reel_likes.create({
          data: { reelId, userId },
        });
        liked = true;
      }

      const likesCount = await tx.reel_likes.count({ where: { reelId } });
      await tx.reels.update({
        where: { id: reelId },
        data: { likesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'reel',
        aggregateId: reelId,
        eventType: 'reel.like.fanout',
        envelopes: [
          {
            event: 'reel:engagement_update',
            rooms: [`reel:${reelId}`],
            payload: {
              reelId,
              type: 'like',
              userId,
              liked,
              likesCount,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'reel',
        aggregateId: reelId,
        eventType: 'reel.like.cache.invalidate',
        tags: [`feed:${reel.authorId}`, `user:${reel.authorId}`],
      });

      return { liked, likesCount };
    },
    {
      maxWait: 10_000,
      timeout: 10_000,
    }
  );
}

export async function createReelCommentWithFanout(
  reelId: string,
  userId: string,
  content: string,
  parentId?: string
): Promise<{ commentPayload: Record<string, unknown>; commentsCount: number } | null> {
  const author = await prisma.user.findUnique({
    where: { id: userId },
    select: reelCommentAuthorSelect,
  });

  return prisma.$transaction(
    async (tx) => {
      const reel = await tx.reels.findUnique({
        where: { id: reelId },
        select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true, allowComments: true },
      });

      if (!reel || !(await canViewReel(reel, userId, {}, tx as any))) {
        return null;
      }
      if (!reel.allowComments) {
        throw new Error('REEL_COMMENTS_DISABLED');
      }
      if (parentId) {
        const parentComment = await tx.reel_comments.findFirst({
          where: { id: parentId, reelId },
          select: { id: true },
        });
        if (!parentComment) {
          throw new Error('REEL_COMMENT_PARENT_NOT_FOUND');
        }
      }

      const comment = await tx.reel_comments.create({
        data: {
          reelId,
          authorId: userId,
          content: content.trim(),
          parentId: parentId || null,
        },
      });

      const commentsCount = await tx.reel_comments.count({
        where: { reelId, parentId: null },
      });
      await tx.reels.update({
        where: { id: reelId },
        data: { commentsCount },
      });

      const commentPayload = {
        id: comment.id,
        reelId: comment.reelId,
        author: author || {
          id: userId,
          username: 'unknown',
          name: 'Unknown User',
          profileImage: null,
        },
        content: comment.content,
        parentId: comment.parentId,
        createdAt: comment.createdAt,
      };

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'reel_comment',
        aggregateId: comment.id,
        eventType: 'reel.comment.fanout',
        envelopes: [
          {
            event: 'reel:engagement_update',
            rooms: [`reel:${reelId}`],
            payload: {
              reelId,
              type: 'comment',
              userId,
              commentsCount,
              comment: commentPayload,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'reel',
        aggregateId: reelId,
        eventType: 'reel.comment.cache.invalidate',
        tags: [`feed:${reel.authorId}`, `user:${reel.authorId}`],
      });

      return { commentPayload, commentsCount };
    },
    {
      maxWait: 10_000,
      timeout: 10_000,
    }
  );
}
