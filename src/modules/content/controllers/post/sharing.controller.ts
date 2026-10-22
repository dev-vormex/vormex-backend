import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prismaRead, prisma } from "../../../../config/prisma";
import { canViewPost } from "../../../../shared/utils/access-control.util";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { recordAuthoritativeRecommendationOutcome } from "../../../discovery/services/recommendation-platform.service";
import { AuthRequest, getPostRealtimeRooms, feedCacheTags } from "./support.controller";

// Share post
export const sharePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const postId = ensureString(req.params.postId);
    // targetUserId from req.body can be used to send DM/notification when implemented

    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true, sharesCount: true },
    });
    if (!post || !(await canViewPost(post, String(req.user.userId)))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const sharesCount = await prisma.$transaction(async (tx) => {
      const updatedPost = await tx.post.update({
        where: { id: postId },
        data: { sharesCount: { increment: 1 } },
        select: { sharesCount: true },
      });
      const nextSharesCount = updatedPost.sharesCount;

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.shared',
        envelopes: [
          {
            event: 'post:shared',
            rooms: getPostRealtimeRooms(postId, post.visibility),
            payload: {
              postId,
              userId: String(req.user!.userId),
              sharesCount: nextSharesCount,
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.shared.cache.invalidate',
        tags: feedCacheTags(`feed:${post.authorId}`, `user:${post.authorId}`),
      });

      return nextSharesCount;
    });

    const frontendUrl = process.env.FRONTEND_URL || 'https://vormex.com';
    void recordAuthoritativeRecommendationOutcome({
      userId: String(req.user.userId), entityType: 'POST', entityId: postId, eventType: 'SHARE', meaningfulOutcome: true,
    }).catch(() => undefined);
    res.status(200).json({
      message: 'Post shared successfully',
      sharesCount,
      shareUrl: `${frontendUrl.replace(/\/$/, '')}/post/${postId}`,
    });
  } catch (error) {
    console.error('sharePost error:', error);
    res.status(500).json({ error: 'Failed to share post' });
  }
};
