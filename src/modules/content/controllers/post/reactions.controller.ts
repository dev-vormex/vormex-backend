import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prismaRead, prisma } from "../../../../config/prisma";
import { canViewPost } from "../../../../shared/utils/access-control.util";
import { normalizeReactionType, getReactionSummaries, type StoredPostMetadata, mapPollOptionsForResponse } from "../../utils/post.util";
import type { RealtimeEnvelope } from "../../../../infrastructure/realtime/channels";
import { randomUUID } from "crypto";
import { enqueueRealtimeFanout, enqueueCacheInvalidation, enqueueNotificationDelivery } from "../../../../infrastructure/outbox/helpers";
import { emitRealtimeEnvelopes } from "../../../../infrastructure/realtime/emitter";
import { notificationService } from "../../../notifications/services/notification.service";
import { recordAuthoritativeRecommendationOutcome } from "../../../discovery/services/recommendation-platform.service";
import { AuthRequest, getPostRealtimeRooms, feedCacheTags } from "./support.controller";

// Toggle like
export const toggleLike = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const liker = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const requestedReaction = normalizeReactionType(req.body?.reactionType);

    const { liked, likesCount, reactionType, reactionSummary, isNewReaction, realtimeEnvelopes } =
      await prisma.$transaction(async (tx) => {
        const existingLike = await tx.postLike.findUnique({
          where: { postId_userId: { postId, userId } },
        });

        // Semantics: no reaction → add; same reaction → remove; different → switch.
        let nextLiked: boolean;
        let nextReaction: string | null;
        if (!existingLike) {
          await tx.postLike.create({
            data: { postId, userId, reactionType: requestedReaction },
          });
          nextLiked = true;
          nextReaction = requestedReaction;
        } else if (existingLike.reactionType === requestedReaction) {
          await tx.postLike.delete({
            where: { postId_userId: { postId, userId } },
          });
          nextLiked = false;
          nextReaction = null;
        } else {
          await tx.postLike.update({
            where: { postId_userId: { postId, userId } },
            data: { reactionType: requestedReaction },
          });
          nextLiked = true;
          nextReaction = requestedReaction;
        }

        const nextLikesCount = await tx.postLike.count({ where: { postId } });
        await tx.post.update({
          where: { id: postId },
          data: { likesCount: nextLikesCount },
        });

        const summaries = await getReactionSummaries(tx as any, [postId]);
        const nextReactionSummary = summaries.get(postId) ?? [];

        /*
         * Built once and used twice: enqueued below for durable cross-instance
         * fanout, and emitted straight to this instance's sockets after the
         * transaction commits. The immediate emit is what makes reactions land
         * in real time — the outbox is only the crash-recovery backstop (see
         * processRealtimeFanout), and it is not drained at all in environments
         * where the BullMQ worker is skipped.
         *
         * The dedupeKey is per-event rather than per (post, user): a viewer can
         * react, unreact and re-react within the emitter's 120s dedupe window,
         * and a stable key would silently swallow every event after the first.
         */
        const envelopes: RealtimeEnvelope[] = [
          {
            event: 'post:liked',
            rooms: getPostRealtimeRooms(postId, post.visibility),
            dedupeKey: `post:liked:${postId}:${randomUUID()}`,
            payload: {
              postId,
              userId,
              liked: nextLiked,
              likesCount: nextLikesCount,
              reactionType: nextReaction,
              reactionSummary: nextReactionSummary,
            },
          },
        ];

        await enqueueRealtimeFanout(tx as any, {
          aggregateType: 'post',
          aggregateId: postId,
          eventType: 'post.like.fanout',
          envelopes,
        });

        await enqueueCacheInvalidation(tx as any, {
          aggregateType: 'post',
          aggregateId: postId,
          eventType: 'post.like.cache.invalidate',
          tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
        });

        // Only notify on a brand-new reaction, not on unreact or reaction switch
        if (!existingLike && nextLiked && post.authorId !== userId) {
          await enqueueNotificationDelivery(tx as any, {
            aggregateType: 'post',
            aggregateId: postId,
            eventType: 'post.like.push',
            payload: {
              kind: 'generic',
              userId: post.authorId,
              title: '❤️ New Like',
              body: `${liker?.name || 'Someone'} liked your post`,
              data: {
                type: 'like',
                postId,
                actorId: userId,
                screen: 'post',
              },
            },
          });
        }

        return {
          liked: nextLiked,
          likesCount: nextLikesCount,
          reactionType: nextReaction,
          reactionSummary: nextReactionSummary,
          isNewReaction: !existingLike && nextLiked,
          realtimeEnvelopes: envelopes,
        };
      });

    // After commit only: emitting inside the transaction would announce a
    // reaction that a rollback then discards, and would race any client that
    // refetches on the event.
    emitRealtimeEnvelopes(realtimeEnvelopes);

    // Send notification on like (not unlike)
    if (isNewReaction && post.authorId !== userId) {
      // Send in-app notification (non-blocking)
      notificationService.notifyPostLike(
        post.authorId,
        userId,
        liker?.name || 'Someone',
        postId
      ).catch(console.error);
    }

    if (liked) {
      void recordAuthoritativeRecommendationOutcome({
        userId, entityType: 'POST', entityId: postId, eventType: 'REACTION', meaningfulOutcome: false,
      }).catch(() => undefined);
    }

    res.json({ liked, isLiked: liked, likesCount, reactionType, reactionSummary });
  } catch (error) {
    console.error('toggleLike error:', error);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
};

// Vote poll
export const votePoll = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const optionId = ensureString(req.body?.optionId);

    if (!postId || !optionId) {
      res.status(400).json({ error: 'Post ID and option ID are required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      include: {
        pollVotes: {
          where: { userId },
          select: { optionId: true, userId: true },
        },
      },
    });

    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const metadata = (post.metadata || {}) as StoredPostMetadata;
    const storedOptions = Array.isArray(metadata.pollOptions) ? metadata.pollOptions : [];
    if (storedOptions.length === 0) {
      res.status(400).json({ error: 'This post is not a poll' });
      return;
    }

    if (metadata.pollEndsAt && new Date(metadata.pollEndsAt) < new Date()) {
      res.status(400).json({ error: 'This poll has ended' });
      return;
    }

    const selectedOption = storedOptions.find((option) => option.id === optionId);
    if (!selectedOption) {
      res.status(400).json({ error: 'Poll option not found' });
      return;
    }

    const existingVote = await prismaRead.postPollVote.findUnique({
      where: { postId_userId: { postId, userId } },
    });
    if (existingVote) {
      res.status(400).json({ error: 'You have already voted on this poll' });
      return;
    }

    const pollOptions = await prisma.$transaction(async (tx) => {
      await tx.postPollVote.create({
        data: { postId, userId, optionId },
      });

      const updatedOptions = storedOptions.map((option) =>
        option.id === optionId
          ? { ...option, votes: Math.max(0, Number(option.votes || 0)) + 1 }
          : { ...option, votes: Math.max(0, Number(option.votes || 0)) }
      );

      const updatedMetadata: StoredPostMetadata = {
        ...metadata,
        pollOptions: updatedOptions,
      };

      await tx.post.update({
        where: { id: postId },
        data: { metadata: updatedMetadata },
      });

      const nextPollOptions = mapPollOptionsForResponse(updatedOptions, optionId);

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.poll.updated',
        envelopes: [
          {
            event: 'poll:updated',
            rooms: getPostRealtimeRooms(postId, post.visibility),
            payload: {
              postId,
              voterId: userId,
              votedOptionId: optionId,
              pollOptions: nextPollOptions,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.poll.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      return nextPollOptions;
    });

    res.json({
      success: true,
      pollOptions,
      userVotedOptionId: optionId,
    });
  } catch (error) {
    console.error('votePoll error:', error);
    res.status(500).json({ error: 'Failed to vote on poll' });
  }
};

// Get post likes list
export const getLikes = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const postId = ensureString(req.params.postId);
    const currentUserId = req.user?.userId ? String(req.user.userId) : null;
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });

    if (!post || !(await canViewPost(post, currentUserId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const likes = await prismaRead.postLike.findMany({
      where: { postId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            headline: true,
            isVerified: true,
            profileBadgeStyle: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.status(200).json({
      likes: likes.map((like) => {
        const likeWithUser = like as typeof like & { user: { id: string; username: string; name: string; profileImage: string | null; headline: string | null } };
        return {
          id: like.id,
          userId: likeWithUser.user.id,
          username: likeWithUser.user.username,
          name: likeWithUser.user.name,
          profileImage: likeWithUser.user.profileImage,
          headline: likeWithUser.user.headline,
          verified: Boolean((likeWithUser.user as any).isVerified),
          isVerified: Boolean((likeWithUser.user as any).isVerified),
          profileBadgeStyle: (likeWithUser.user as any).profileBadgeStyle ?? null,
          reactionType: like.reactionType || 'LIKE',
          createdAt: like.createdAt,
        };
      }),
    });
  } catch (error) {
    console.error('getLikes error:', error);
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
};
