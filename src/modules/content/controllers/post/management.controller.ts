import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import type { Prisma } from '@prisma/client';
import { prisma, JOIN_RELATIONS } from "../../../../config/prisma";
import { parseVisibility, attachReactionSummaries, mapPostResponse, parseStringArrayField } from "../../utils/post.util";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { randomUUID } from "crypto";
import { notificationService } from "../../../notifications/services/notification.service";
import { canViewPost } from "../../../../shared/utils/access-control.util";
import { enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { AuthRequest, postResponseInclude, collectOwnedPostMediaUrls, deleteOwnedPostMedia } from "./support.controller";
import { HOME_FEED_CACHE_GLOBAL_TAG, feedSnapshotCacheTags } from "./feed-context.controller";

// Update post
export const updatePost = async (req: AuthRequest, res: Response): Promise<void> => {
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

    const existing = await prisma.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only edit your own posts' });
      return;
    }

    const data: { content?: string; visibility?: string } = {};
    if (typeof req.body.content === 'string') {
      data.content = req.body.content.trim();
    }
    if (typeof req.body.visibility === 'string') {
      data.visibility = parseVisibility(req.body.visibility);
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data,
      include: postResponseInclude(userId),
    });

    await attachReactionSummaries(prisma as any, [updated]);
    await cacheService.invalidateTags(
      HOME_FEED_CACHE_GLOBAL_TAG,
      `feed:${userId}`,
      `user:${userId}`
    ).catch(() => undefined);
    res.status(200).json(mapPostResponse(updated, userId));
  } catch (error) {
    console.error('updatePost error:', error);
    res.status(500).json({ error: 'Failed to update post' });
  }
};

// Accept or reject a post collaboration invite
export const respondToPostCollabInvite = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const action = (ensureString(req.body?.action) || '').toLowerCase();
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }
    if (!['accept', 'reject'].includes(action)) {
      res.status(400).json({ error: 'action must be "accept" or "reject"' });
      return;
    }

    const post = await prisma.post.findFirst({
      where: { id: postId, isActive: true },
      select: {
        id: true,
        authorId: true,
        metadata: true,
      },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    if (post.authorId === userId) {
      res.status(400).json({ error: 'You cannot respond to your own collaboration invite' });
      return;
    }

    const existingCollaboration = await (prisma as any).postCollaborator.findUnique({
      where: { postId_userId: { postId, userId } },
      select: { id: true, status: true },
    }).catch(() => null);
    const rawMetadata =
      post.metadata && typeof post.metadata === 'object' && !Array.isArray(post.metadata)
        ? { ...(post.metadata as Record<string, unknown>) }
        : {};
    const pendingFromMetadata = [
      ...parseStringArrayField(rawMetadata.pendingCollaboratorIds),
      ...parseStringArrayField(rawMetadata.collaboratorIds),
    ];
    const wasInvited = Boolean(existingCollaboration) || pendingFromMetadata.includes(userId);
    if (!wasInvited) {
      res.status(404).json({ error: 'Collaboration invite not found' });
      return;
    }

    const nextStatus = action === 'accept' ? 'accepted' : 'rejected';
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await (tx as any).postCollaborator.upsert({
        where: { postId_userId: { postId, userId } },
        create: {
          id: randomUUID(),
          postId,
          userId,
          invitedById: post.authorId,
          status: nextStatus,
          respondedAt: now,
        },
        update: {
          status: nextStatus,
          respondedAt: now,
        },
      });

      const metadata: Prisma.InputJsonObject & { pendingCollaboratorIds?: string[]; collaboratorIds?: string[] } = { ...rawMetadata } as Prisma.InputJsonObject;
      const pendingCollaboratorIds = parseStringArrayField(metadata.pendingCollaboratorIds)
        .filter((collaboratorId) => collaboratorId !== userId);
      const collaboratorIds = parseStringArrayField(metadata.collaboratorIds)
        .filter((collaboratorId) => collaboratorId !== userId);
      if (nextStatus === 'accepted') {
        collaboratorIds.push(userId);
      }
      metadata.pendingCollaboratorIds = Array.from(new Set(pendingCollaboratorIds));
      metadata.collaboratorIds = Array.from(new Set(collaboratorIds));

      await tx.post.update({
        where: { id: postId },
        data: { metadata },
      });

      const inviteNotifications = await tx.notifications.findMany({
        where: {
          userId,
          postId,
          type: 'mention',
        },
        select: {
          id: true,
          data: true,
        },
      });

      await Promise.all(
        inviteNotifications
          .filter((notification) => {
            const data = notification.data as Record<string, unknown> | null;
            return data?.context === 'post_collab_invite';
          })
          .map((notification) => {
            const data = (notification.data || {}) as Record<string, unknown>;
            return tx.notifications.update({
              where: { id: notification.id },
              data: {
                isRead: true,
                readAt: now,
                data: {
                  ...data,
                  collabStatus: nextStatus,
                  respondedAt: now.toISOString(),
                },
              },
            });
          })
      );
    });

    await cacheService.invalidateTags(
      HOME_FEED_CACHE_GLOBAL_TAG,
      `feed:${userId}`,
      `user:${userId}`,
      `user:${post.authorId}`,
      `notifications:${userId}`
    ).catch(() => undefined);

    if (nextStatus === 'accepted') {
      const collaborator = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true },
      });
      const collaboratorName = collaborator?.name || collaborator?.username || 'Someone';
      notificationService.createNotification({
        userId: post.authorId,
        type: 'mention',
        title: '🤝 Collaboration accepted',
        body: `${collaboratorName} accepted your post collaboration invite`,
        actorId: userId,
        postId,
        data: {
          type: 'mention',
          screen: 'post',
          context: 'post_collab_accepted',
          actorId: userId,
          postId,
        },
      }).catch(() => undefined);
    }

    const updatedPost = await prisma.post.findUnique({
      where: { id: postId },
      include: postResponseInclude(userId),
      relationLoadStrategy: JOIN_RELATIONS,
    });

    /*
     * Accepting is what grants access to a non-public post, so the body only
     * comes back once that access actually holds. Rejecting leaves the invitee
     * outside the audience, and returning the post anyway would hand them
     * content that GET /posts/:postId now refuses them.
     */
    const canReadUpdatedPost = updatedPost ? await canViewPost(updatedPost, userId) : false;

    res.status(200).json({
      success: true,
      status: nextStatus,
      post: updatedPost && canReadUpdatedPost ? mapPostResponse(updatedPost, userId) : null,
    });
  } catch (error) {
    console.error('respondToPostCollabInvite error:', error);
    res.status(500).json({ error: 'Failed to respond to collaboration invite' });
  }
};

// Delete post
export const deletePost = async (req: AuthRequest, res: Response): Promise<void> => {
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

    const existing = await prisma.post.findFirst({
      where: { id: postId, isActive: true },
      select: {
        id: true,
        authorId: true,
        mediaUrls: true,
        metadata: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own posts' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.post.update({
        where: { id: postId },
        data: { isActive: false },
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.deleted.cache.invalidate',
        tags: feedSnapshotCacheTags(`feed:${userId}`, `user:${userId}`),
      });
    });

    const mediaUrls = collectOwnedPostMediaUrls(existing, userId);
    if (mediaUrls.length > 0) {
      await deleteOwnedPostMedia(mediaUrls);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('deletePost error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
};
