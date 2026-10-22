import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { Prisma } from '@prisma/client';
import { prismaRead, JOIN_RELATIONS, prisma } from "../../../../config/prisma";
import { buildPostVisibilityWhere, canViewPost } from "../../../../shared/utils/access-control.util";
import { attachReactionSummaries, mapPostResponse, parseVisibility, normalizeUrl, parseStringArrayField, type StoredPostMetadata, enrichLinkMetadataFromUrl } from "../../utils/post.util";
import { type FinalizedDirectMedia } from "../../utils/direct-media-upload.util";
import { enforceTrustTierLimit, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { imageProcessingService } from "../../../../infrastructure/media/image-processing.service";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";
import { randomUUID } from "crypto";
import { enqueueRealtimeFanout, enqueueCacheInvalidation } from "../../../../infrastructure/outbox/helpers";
import { recordActivity } from "../../../engagement/services/activity.service";
import { updateEngagementStreak } from "../../../engagement/services/streak.service";
import { notificationService } from "../../../notifications/services/notification.service";
import { AuthRequest, postResponseInclude, validateDirectPostMedia, buildMetadataFromRequest, FEED_REALTIME_ROOM, feedCacheTags } from "./support.controller";
import { enqueuePostCreatedFollowerFeedInvalidation } from "./feed-context.controller";

// Get single post
export const getPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: {
        id: postId,
        isActive: true,
        ...(await buildPostVisibilityWhere(currentUserId)),
      },
      include: postResponseInclude(currentUserId),
      relationLoadStrategy: JOIN_RELATIONS,
    });

    if (!post) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    await attachReactionSummaries(prismaRead as any, [post]);
    res.status(200).json(mapPostResponse(post, currentUserId));
  } catch (error) {
    console.error('getPost error:', error);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
};

// Create post
export const createPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const typeRaw = String(req.body.type || 'TEXT').toUpperCase();
    const visibilityRaw = String(req.body.visibility || 'PUBLIC');
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';

    const mappedType = typeRaw.toLowerCase();
    const visibility = parseVisibility(visibilityRaw);
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    const imageFiles = files.filter((file) => file.mimetype?.startsWith('image/'));
    const videoFiles = files.filter((file) => file.mimetype?.startsWith('video/'));
    let directMedia: Array<FinalizedDirectMedia & { url: string }> = [];
    try {
      directMedia = await validateDirectPostMedia(userId, req.body.directMedia);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid direct media' });
      return;
    }
    const directImageCount = directMedia.filter((item) => item.mimeType.startsWith('image/')).length;
    const directVideoCount = directMedia.filter((item) => item.mimeType.startsWith('video/')).length;

    if (mappedType === 'text' && !content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    if (mappedType === 'image' && imageFiles.length + directImageCount === 0) {
      res.status(400).json({ error: 'At least one image is required' });
      return;
    }

    if (mappedType === 'video' && videoFiles.length + directVideoCount === 0) {
      res.status(400).json({ error: 'A video file is required' });
      return;
    }

    if (mappedType === 'link' && !normalizeUrl(req.body.linkUrl)) {
      res.status(400).json({ error: 'Link URL is required' });
      return;
    }

    if (mappedType === 'poll' && parseStringArrayField(req.body.pollOptions).length < 2) {
      res.status(400).json({ error: 'At least 2 poll options are required' });
      return;
    }

    if (mappedType === 'article' && !ensureString(req.body.articleTitle)) {
      res.status(400).json({ error: 'Article title is required' });
      return;
    }

    if (mappedType === 'celebration' && !ensureString(req.body.celebrationType)) {
      res.status(400).json({ error: 'Celebration type is required' });
      return;
    }

    await enforceTrustTierLimit(userId, 'post');
    if (files.length > 0 || directMedia.length > 0) {
      await enforceTrustTierLimit(userId, 'media');
    }

    const mediaUrls: string[] = directMedia.map((item) => item.url);

    // Upload images/videos to Bunny.net CDN
    if (files.length > 0) {
      if (!process.env.BUNNY_STORAGE_API_KEY) {
        res.status(500).json({ error: 'Media storage is not configured. Please contact support.' });
        return;
      }
      
      try {
        /*
         * Each file is independent, so they downscale and upload concurrently.
         * Serial awaits made a four-image post wait for four full CDN round
         * trips end to end.
         *
         * Order still matters — the client renders mediaUrls positionally — so
         * results are collected by index rather than pushed on completion.
         */
        const [imageUrls, videoUrls] = await Promise.all([
          Promise.all(
            imageFiles.map(async (file, index) => {
              const sourceMimeType = file.mimetype || 'image/jpeg';
              const processed = await imageProcessingService.processPostImage(
                file.buffer,
                sourceMimeType
              );
              return bunnyStorageService.uploadPostImage(
                processed?.buffer || file.buffer,
                userId,
                index,
                processed?.mimeType || sourceMimeType
              );
            })
          ),
          Promise.all(
            videoFiles.map((v) =>
              bunnyStorageService.uploadPostVideo(
                v.buffer,
                userId,
                v.mimetype || 'video/mp4'
              )
            )
          ),
        ]);
        mediaUrls.push(...imageUrls, ...videoUrls);
      } catch (uploadError) {
        console.error('Failed to upload media to CDN:', uploadError);
        res.status(500).json({ error: 'Failed to upload media. Please try again.' });
        return;
      }
    }

    let metadata: StoredPostMetadata | null = null;
    try {
      metadata = buildMetadataFromRequest(req.body || {}, mappedType, mediaUrls);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid post metadata';
      if (message.startsWith('VALIDATION:')) {
        res.status(400).json({ error: message.replace('VALIDATION:', '') });
        return;
      }
      throw error;
    }

    if (metadata && mappedType === 'link') {
      await enrichLinkMetadataFromUrl(metadata);
    }

    const requestedCollaboratorIds = Array.from(new Set(parseStringArrayField(metadata?.pendingCollaboratorIds)))
      .filter((collaboratorId) => collaboratorId && collaboratorId !== userId)
      .slice(0, 30);
    const validCollaboratorIds =
      requestedCollaboratorIds.length > 0
        ? (
            await prismaRead.user.findMany({
              where: {
                id: { in: requestedCollaboratorIds },
                isBanned: false,
              },
              select: { id: true },
            })
          ).map((user) => user.id)
        : [];

    if (metadata?.pendingCollaboratorIds) {
      metadata.pendingCollaboratorIds = validCollaboratorIds;
    }

    const peerIds =
      visibility === 'connections'
        ? Array.from(
            new Set(
              (
                await prismaRead.connections.findMany({
                  where: {
                    status: 'accepted',
                    OR: [{ requesterId: userId }, { addresseeId: userId }],
                  },
                  select: { requesterId: true, addresseeId: true },
                })
              ).flatMap((connection) => [connection.requesterId, connection.addresseeId])
            )
          ).filter((peerId) => peerId !== userId)
        : [];

	    const created = await prisma.$transaction(async (tx) => {
      const nextPost = await tx.post.create({
        data: {
          authorId: userId,
          content: content || '',
          type: mappedType,
          visibility,
          mediaUrls,
          metadata: metadata ?? Prisma.DbNull,
        },
        include: postResponseInclude(userId),
      });

      if (validCollaboratorIds.length > 0) {
        await (tx as any).postCollaborator.createMany({
          data: validCollaboratorIds.map((collaboratorId) => ({
            id: randomUUID(),
            postId: nextPost.id,
            userId: collaboratorId,
            invitedById: userId,
            status: 'pending',
          })),
          skipDuplicates: true,
        });
      }

      const mappedPost = mapPostResponse(nextPost, userId);
      const envelopes: Array<Record<string, unknown>> = [
        {
          event: 'streak:updated',
          users: [userId],
          payload: { type: 'posting' },
        },
      ];

      if (visibility === 'public') {
        envelopes.push({
          event: 'post:created',
          rooms: [FEED_REALTIME_ROOM],
          payload: { post: mappedPost },
        });
      } else if (visibility === 'connections') {
        envelopes.push({
          event: 'post:created',
          users: [userId, ...peerIds],
          payload: { post: mappedPost },
        });
      } else {
        envelopes.push({
          event: 'post:created',
          users: [userId],
          payload: { post: mappedPost },
        });
      }

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: nextPost.id,
        eventType: 'post.created.fanout',
        envelopes: envelopes as any,
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: nextPost.id,
        eventType: 'post.created.cache.invalidate',
        tags: feedCacheTags(`feed:${userId}`, `user:${userId}`),
      });

      return nextPost;
    });

    await enqueuePostCreatedFollowerFeedInvalidation(created.id, userId);

    // Record activity and update posting streak (non-blocking)
    const activityType = mappedType === 'article' ? 'article' : 'post';
    recordActivity(userId, activityType, 1, { sourceId: created.id }).catch(console.error);
    updateEngagementStreak(userId, 'posting').catch(console.error);

    const collaboratorIds = validCollaboratorIds;
    const collaboratorIdSet = new Set(collaboratorIds);
    const mentionedUserIds = Array.from(new Set(parseStringArrayField(metadata?.mentions)))
      .filter((mentionedUserId) => mentionedUserId && mentionedUserId !== userId)
      .filter((mentionedUserId) => !collaboratorIdSet.has(mentionedUserId))
      .slice(0, 30);
    if (mentionedUserIds.length > 0 || collaboratorIds.length > 0) {
      Promise.resolve()
        .then(async () => {
          const [mentionableUsers, collaboratorUsers] = await Promise.all([
            mentionedUserIds.length > 0 ? prisma.user.findMany({
              where: {
                id: { in: mentionedUserIds },
                isBanned: false,
              },
              select: { id: true },
            }) : [],
            collaboratorIds.length > 0 ? prisma.user.findMany({
              where: {
                id: { in: collaboratorIds },
                isBanned: false,
              },
              select: { id: true },
            }) : [],
          ]);
          const mentionerName = created.author?.name || created.author?.username || 'Someone';
          const genericPreview = `${mentionerName} tagged you in a ${mappedType} post`;
          const postForAccess = { id: created.id, authorId: userId, visibility, isActive: true };
          const recipientIds = Array.from(new Set([
            ...mentionableUsers.map((mentionedUser) => mentionedUser.id),
            ...collaboratorUsers.map((collaboratorUser) => collaboratorUser.id),
          ]));
          const canReadById = new Map(
            await Promise.all(
              recipientIds.map(
                async (recipientId) => [recipientId, await canViewPost(postForAccess, recipientId)] as const
              )
            )
          );

          await Promise.all([
            /*
             * A mention must not become a side channel around the post's own
             * visibility. The preview carries the raw post body, so notifying
             * someone who cannot open the post would publish private content
             * into their notification list: an "Only me" post notifies nobody,
             * and a connections-only post notifies connections only.
             */
            ...mentionableUsers
              .filter((mentionedUser) => canReadById.get(mentionedUser.id))
              .map((mentionedUser) =>
                notificationService.notifyMention(
                  mentionedUser.id,
                  userId,
                  mentionerName,
                  'post',
                  created.id,
                  content || genericPreview
                )
              ),
            /*
             * Collaborator invites still go out — the author picked these users
             * and accepting the invite is what grants access — but the invite
             * withholds the body until the invitee can actually read the post.
             */
            ...collaboratorUsers.map((collaboratorUser) =>
              notificationService.notifyPostCollabInvite(
                collaboratorUser.id,
                userId,
                mentionerName,
                created.id,
                canReadById.get(collaboratorUser.id) ? (content || genericPreview) : genericPreview
              )
            ),
          ]);
        })
        .catch(console.error);
    }

    res.status(201).json(mapPostResponse(created, userId));
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('createPost error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
};

export const finalizePostUpload = createPost;
