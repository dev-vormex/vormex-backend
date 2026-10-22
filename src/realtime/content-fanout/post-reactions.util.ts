import type { RealtimeEnvelope } from "../../infrastructure/realtime/channels";
import { normalizeReactionType, getReactionSummaries, getPostMetadata, mapPollOptionsForResponse } from "../../modules/content/utils/post.util";
import { prisma } from "../../config/prisma";
import { canViewPost } from "../../shared/utils/access-control.util";
import { randomUUID } from "crypto";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../infrastructure/outbox/helpers";
import { assertUsersCanInteract } from "../../modules/safety/services/trust-safety.service";
import { feedRealtimeRoom } from "./support.util";

export async function togglePostReactionWithFanout(
  postId: string,
  userId: string,
  reactionType: string | null,
  eventName: 'post:liked' | 'post:reacted'
): Promise<{
  liked: boolean;
  likesCount: number;
  reactionType: string | null;
  realtimeEnvelopes: RealtimeEnvelope[];
} | null> {
  const requestedReaction = normalizeReactionType(reactionType);
  return prisma.$transaction(
    async (tx) => {
      const post = await tx.post.findFirst({
        where: { id: postId, isActive: true },
        select: { id: true, authorId: true, visibility: true, isActive: true },
      });

      if (!post || !(await canViewPost(post, userId, tx as any))) {
        return null;
      }

      const existingLike = await tx.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      });

      // Semantics: no reaction → add; same reaction → remove; different → switch.
      let liked: boolean;
      let nextReaction: string | null;
      if (!existingLike) {
        await tx.postLike.create({
          data: { postId, userId, reactionType: requestedReaction },
        });
        liked = true;
        nextReaction = requestedReaction;
      } else if (existingLike.reactionType === requestedReaction) {
        await tx.postLike.delete({
          where: { postId_userId: { postId, userId } },
        });
        liked = false;
        nextReaction = null;
      } else {
        await tx.postLike.update({
          where: { postId_userId: { postId, userId } },
          data: { reactionType: requestedReaction },
        });
        liked = true;
        nextReaction = requestedReaction;
      }

      const likesCount = await tx.postLike.count({ where: { postId } });
      await tx.post.update({
        where: { id: postId },
        data: { likesCount },
      });
      const summaries = await getReactionSummaries(tx as any, [postId]);
      const reactionSummary = summaries.get(postId) ?? [];
      const postRooms =
        String(post.visibility || '').toLowerCase() === 'public'
          ? [feedRealtimeRoom, `post:${postId}`]
          : [`post:${postId}`];

      // Same contract as the REST path in post.controller.ts: build once, enqueue
      // for durability, and emit immediately after commit. See the comment there
      // for why the dedupeKey must be unique per event.
      const realtimeEnvelopes: RealtimeEnvelope[] = [
        {
          event: eventName,
          rooms: postRooms,
          dedupeKey: `${eventName}:${postId}:${randomUUID()}`,
          payload: {
            postId,
            userId,
            liked,
            reactionType: nextReaction,
            likesCount,
            reactionSummary,
          },
        },
      ];

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: `post.${eventName}.fanout`,
        envelopes: realtimeEnvelopes,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.engagement.cache.invalidate',
        tags: ['feed:global', `feed:${post.authorId}`, `user:${post.authorId}`],
      });

      return {
        liked,
        likesCount,
        reactionType: nextReaction,
        realtimeEnvelopes,
      };
    },
    {
      maxWait: 10_000,
      timeout: 10_000,
    }
  );
}

export async function toggleCommentLikeWithFanout(
  postId: string,
  commentId: string,
  userId: string
): Promise<{ liked: boolean; likesCount: number } | null> {
  return prisma.$transaction(
    async (tx) => {
      const comment = await tx.post_comments.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          postId: true,
          authorId: true,
          posts: { select: { authorId: true, visibility: true, isActive: true } },
        },
      });

      if (!comment || comment.postId !== postId || !(await canViewPost(comment.posts, userId, tx as any))) {
        return null;
      }
      await assertUsersCanInteract(userId, comment.authorId, 'comment reaction');

      const existing = await tx.comment_likes.findUnique({
        where: { commentId_userId: { commentId, userId } },
      });

      let liked = false;
      if (existing) {
        await tx.comment_likes.delete({
          where: { commentId_userId: { commentId, userId } },
        });
      } else {
        await tx.comment_likes.create({
          data: { commentId, userId },
        });
        liked = true;
      }

      const likesCount = await tx.comment_likes.count({ where: { commentId } });
      await tx.post_comments.update({
        where: { id: commentId },
        data: { likesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post_comment',
        aggregateId: commentId,
        eventType: 'post.comment.like.fanout',
        envelopes: [
          {
            event: 'comment:liked',
            rooms: [`post:${postId}`],
            payload: {
              commentId,
              postId,
              userId,
              liked,
              likesCount,
            },
          },
        ],
      });

      return { liked, likesCount };
    },
    {
      maxWait: 10_000,
      timeout: 10_000,
    }
  );
}

export async function votePollWithFanout(
  postId: string,
  optionId: string,
  userId: string
): Promise<Array<Record<string, unknown>> | null> {
  return prisma.$transaction(
    async (tx) => {
      const post = await tx.post.findFirst({
        where: { id: postId, isActive: true },
        select: { id: true, authorId: true, visibility: true, isActive: true, metadata: true },
      });

      if (!post || !(await canViewPost(post, userId, tx as any))) {
        return null;
      }

      const metadata = getPostMetadata(post.metadata);
      const pollOptions = metadata.pollOptions || [];
      if (pollOptions.length === 0) {
        throw new Error('POLL_NOT_FOUND');
      }
      if (metadata.pollEndsAt && new Date(metadata.pollEndsAt) < new Date()) {
        throw new Error('POLL_ENDED');
      }
      if (!pollOptions.find((option) => option.id === optionId)) {
        throw new Error('POLL_OPTION_NOT_FOUND');
      }

      const existingVote = await tx.postPollVote.findUnique({
        where: { postId_userId: { postId, userId } },
      });
      if (existingVote) {
        throw new Error('POLL_ALREADY_VOTED');
      }

      await tx.postPollVote.create({
        data: { postId, userId, optionId },
      });

      const updatedOptions = pollOptions.map((option) =>
        option.id === optionId
          ? { ...option, votes: Math.max(0, Number(option.votes || 0)) + 1 }
          : { ...option, votes: Math.max(0, Number(option.votes || 0)) }
      );

      await tx.post.update({
        where: { id: postId },
        data: {
          metadata: {
            ...((post.metadata || {}) as object),
            pollOptions: updatedOptions,
          },
        },
      });

      const responseOptions = mapPollOptionsForResponse(updatedOptions, optionId);
      const postRooms =
        String(post.visibility || '').toLowerCase() === 'public'
          ? [feedRealtimeRoom, `post:${postId}`]
          : [`post:${postId}`];

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.poll.vote.fanout',
        envelopes: [
          {
            event: 'poll:updated',
            rooms: postRooms,
            payload: {
              postId,
              voterId: userId,
              votedOptionId: optionId,
              pollOptions: responseOptions,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.poll.cache.invalidate',
        tags: ['feed:global', `feed:${post.authorId}`, `user:${post.authorId}`],
      });

      return responseOptions as any;
    },
    {
      maxWait: 10_000,
      timeout: 10_000,
    }
  );
}
