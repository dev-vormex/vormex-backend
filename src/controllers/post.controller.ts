// @ts-nocheck
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { prisma, prismaRead } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { notificationService } from '../services/notification.service';
import { recordActivity } from '../services/activity.service';
import { updateEngagementStreak } from './engagement.controller';
import { rankFeed } from '../services/feed-algorithm.service';
import {
  enqueueCacheInvalidation,
  enqueueNotificationDelivery,
  enqueueRealtimeFanout,
} from '../outbox/helpers';
import {
  extractDomain,
  mapPollOptionsForResponse,
  mapPostResponse,
  parseBooleanField,
  parseNumberField,
  parseStringArrayField,
  parseVisibility,
  normalizeUrl,
  enrichLinkMetadataFromUrl,
  type StoredPostMetadata,
} from '../utils/post.util';
import { parseStoredMusicAttachment } from '../utils/music.util';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const FEED_REALTIME_ROOM = 'feed:global';

function buildMetadataFromRequest(
  body: Record<string, unknown>,
  mappedType: string,
  mediaUrls: string[]
): StoredPostMetadata | null {
  const metadata: StoredPostMetadata = {};
  const mentions = parseStringArrayField(body.mentions);
  const music = parseStoredMusicAttachment(body.music);

  if (mentions.length > 0) {
    metadata.mentions = mentions;
  }

  if (music) {
    metadata.music = music;
  }

  if (mappedType === 'video' && mediaUrls[0]) {
    metadata.videoUrl = mediaUrls[0];
  }

  if (mappedType === 'link') {
    const linkUrl = normalizeUrl(body.linkUrl);
    if (!linkUrl) {
      throw new Error('VALIDATION:Link URL is required');
    }

    metadata.linkUrl = linkUrl;
    metadata.linkTitle = ensureString(body.linkTitle) || extractDomain(linkUrl) || linkUrl;
    metadata.linkDescription = ensureString(body.linkDescription) || null;
    metadata.linkImage = normalizeUrl(body.linkImage);
    metadata.linkDomain = extractDomain(linkUrl);
  }

  if (mappedType === 'poll') {
    const optionTexts = parseStringArrayField(body.pollOptions).slice(0, 6);
    if (optionTexts.length < 2) {
      throw new Error('VALIDATION:At least 2 poll options are required');
    }

    const pollDuration = Math.max(1, parseNumberField(body.pollDuration) ?? 24);
    metadata.pollDuration = pollDuration;
    metadata.pollEndsAt = new Date(Date.now() + pollDuration * 60 * 60 * 1000).toISOString();
    metadata.showResultsBeforeVote = parseBooleanField(body.showResultsBeforeVote, false);
    metadata.pollOptions = optionTexts.map((text) => ({
      id: randomUUID(),
      text,
      votes: 0,
    }));
  }

  if (mappedType === 'article') {
    const articleTitle = ensureString(body.articleTitle);
    if (!articleTitle) {
      throw new Error('VALIDATION:Article title is required');
    }

    metadata.articleTitle = articleTitle;
    metadata.articleTags = parseStringArrayField(body.articleTags);
    metadata.articleCoverImage = mediaUrls[0] || null;
    metadata.articleReadTime = Math.max(
      1,
      Math.ceil((ensureString(body.content)?.split(/\s+/).length ?? 0) / 200)
    );
  }

  if (mappedType === 'celebration') {
    const celebrationType = ensureString(body.celebrationType);
    if (!celebrationType) {
      throw new Error('VALIDATION:Celebration type is required');
    }

    metadata.celebrationType = celebrationType;
    const celebrationBadge = ensureString(body.celebrationBadge);
    if (celebrationBadge) {
      metadata.celebrationBadge = celebrationBadge;
    }
    if (mediaUrls[0]) {
      metadata.celebrationGifUrl = mediaUrls[0];
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

// Get feed
export const getFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const cursor = ensureString(req.query.cursor);
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);
    const modeRaw = (ensureString(req.query.mode) || 'recommended').toLowerCase();
    const mode: 'latest' | 'recommended' = modeRaw === 'latest' ? 'latest' : 'recommended';

    const acceptedConnections = await prismaRead.connections.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: currentUserId }, { addresseeId: currentUserId }],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const connectedUserIds = new Set(
      acceptedConnections.flatMap((c) => [c.requesterId, c.addresseeId]),
    );
    connectedUserIds.delete(currentUserId);
    const connectionAuthorIds = Array.from(connectedUserIds);

    const feedVisibilityOr: Array<Record<string, unknown>> = [
      { visibility: 'public' },
      { authorId: currentUserId },
    ];
    if (connectionAuthorIds.length > 0) {
      feedVisibilityOr.push({
        AND: [{ visibility: 'connections' }, { authorId: { in: connectionAuthorIds } }],
      });
    }

    const postsPromise = prismaRead.post.findMany({
      where: {
        isActive: true,
        OR: feedVisibilityOr,
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            headline: true,
          },
        },
        likes: {
          where: { userId: currentUserId },
          select: { userId: true },
        },
        saved_posts: {
          where: { userId: currentUserId },
          select: { userId: true },
        },
        pollVotes: {
          where: { userId: currentUserId },
          select: { optionId: true, userId: true },
        },
        _count: { select: { saved_posts: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const feedImpressionsModel = (prismaRead as any).feed_impressions;
    const impressionsPromise =
      mode === 'recommended' && feedImpressionsModel
        ? feedImpressionsModel.findMany({
            where: {
              userId: currentUserId,
              seenAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
            select: { postId: true },
          })
        : Promise.resolve([]);

    const [posts, impressions] = await Promise.all([postsPromise, impressionsPromise]);

    const hasMore = posts.length > limit;
    const chronologicalItems = hasMore ? posts.slice(0, limit) : posts;

    const seenPostIds = Array.isArray(impressions)
      ? impressions.map((item: { postId: string }) => item.postId)
      : [];

    let pageItems = chronologicalItems;
    if (mode === 'recommended') {
      try {
        pageItems = rankFeed(chronologicalItems, seenPostIds);
      } catch (rankingError) {
        console.error('Feed ranking failed, falling back to latest ordering:', rankingError);
        pageItems = chronologicalItems;
      }
    }

    res.json({
      posts: pageItems.map((post) => mapPostResponse(post, currentUserId)),
      // Keep cursor progression tied to chronological batch for backward-compatible pagination.
      nextCursor: hasMore ? chronologicalItems[chronologicalItems.length - 1].id : null,
      hasMore,
    });

    if (mode === 'recommended' && feedImpressionsModel && pageItems.length > 0) {
      const uniquePostIds = Array.from(new Set(pageItems.map((post) => post.id)));
      const now = new Date();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Fire-and-forget: never block feed response on impression writes.
      void Promise.all(
        uniquePostIds.map((postId) =>
          feedImpressionsModel.upsert({
            where: { userId_postId: { userId: currentUserId, postId } },
            create: { userId: currentUserId, postId, seenAt: now },
            update: { seenAt: now },
          })
        )
      )
        .then(() =>
          feedImpressionsModel.deleteMany({
            where: { seenAt: { lt: sevenDaysAgo } },
          })
        )
        .catch((impressionError: unknown) => {
          console.error('Failed to write feed impressions:', impressionError);
        });
    }
  } catch (error) {
    console.error('getFeed error:', error);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
};

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
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            headline: true,
          },
        },
        likes: {
          where: { userId: currentUserId },
          select: { userId: true },
        },
        saved_posts: {
          where: { userId: currentUserId },
          select: { userId: true },
        },
        pollVotes: {
          where: { userId: currentUserId },
          select: { optionId: true, userId: true },
        },
        _count: { select: { saved_posts: true } },
      },
    });

    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (post.visibility === 'private' && post.authorId !== currentUserId) {
      res.status(403).json({ error: 'Post is private' });
      return;
    }

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

    if (mappedType === 'text' && !content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    if (mappedType === 'image' && imageFiles.length === 0) {
      res.status(400).json({ error: 'At least one image is required' });
      return;
    }

    if (mappedType === 'video' && videoFiles.length === 0) {
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

    const mediaUrls: string[] = [];

    // Upload images/videos to Bunny.net CDN
    if (files.length > 0) {
      if (!process.env.BUNNY_STORAGE_API_KEY) {
        res.status(500).json({ error: 'Media storage is not configured. Please contact support.' });
        return;
      }
      
      try {
        for (let i = 0; i < imageFiles.length; i++) {
          const url = await bunnyStorageService.uploadPostImage(
            imageFiles[i].buffer,
            userId,
            i,
            imageFiles[i].mimetype || 'image/jpeg'
          );
          mediaUrls.push(url);
        }
        for (const v of videoFiles) {
          const url = await bunnyStorageService.uploadPostVideo(
            v.buffer,
            userId,
            v.mimetype || 'video/mp4'
          );
          mediaUrls.push(url);
        }
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
          metadata,
        },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
            },
          },
          likes: {
            where: { userId },
            select: { userId: true },
          },
          saved_posts: {
            where: { userId },
            select: { userId: true },
          },
          pollVotes: {
            where: { userId },
            select: { optionId: true, userId: true },
          },
          _count: { select: { saved_posts: true } },
        },
      });

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
        tags: [`feed:${userId}`, `user:${userId}`],
      });

      return nextPost;
    });

    // Record activity and update posting streak (non-blocking)
    const activityType = mappedType === 'article' ? 'article' : 'post';
    recordActivity(userId, activityType, 1).catch(console.error);
    updateEngagementStreak(userId, 'posting').catch(console.error);

    res.status(201).json(mapPostResponse(created, userId));
  } catch (error) {
    console.error('createPost error:', error);
    res.status(500).json({ error: 'Failed to create post' });
  }
};

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
      include: {
        author: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            headline: true,
          },
        },
        likes: {
          where: { userId },
          select: { userId: true },
        },
        saved_posts: {
          where: { userId },
          select: { userId: true },
        },
        pollVotes: {
          where: { userId },
          select: { optionId: true, userId: true },
        },
        _count: { select: { saved_posts: true } },
      },
    });

    res.status(200).json(mapPostResponse(updated, userId));
  } catch (error) {
    console.error('updatePost error:', error);
    res.status(500).json({ error: 'Failed to update post' });
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
      select: { id: true, authorId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own posts' });
      return;
    }

    await prisma.post.update({
      where: { id: postId },
      data: { isActive: false },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('deletePost error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
};

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
      select: { id: true, authorId: true },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const { liked, likesCount } = await prisma.$transaction(async (tx) => {
      const existingLike = await tx.postLike.findUnique({
        where: { postId_userId: { postId, userId } },
      });

      let nextLiked = false;
      if (existingLike) {
        await tx.postLike.delete({
          where: { postId_userId: { postId, userId } },
        });
      } else {
        await tx.postLike.create({
          data: { postId, userId },
        });
        nextLiked = true;
      }

      const nextLikesCount = await tx.postLike.count({ where: { postId } });
      await tx.post.update({
        where: { id: postId },
        data: { likesCount: nextLikesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.like.fanout',
        envelopes: [
          {
            event: 'post:liked',
            rooms: [FEED_REALTIME_ROOM, `post:${postId}`],
            payload: {
              postId,
              userId,
              liked: nextLiked,
              likesCount: nextLikesCount,
              reactionType: nextLiked ? 'LIKE' : null,
              reactionSummary: [],
            },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.like.cache.invalidate',
        tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
      });

      if (nextLiked && post.authorId !== userId) {
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

      return { liked: nextLiked, likesCount: nextLikesCount };
    });

    // Send notification on like (not unlike)
    if (liked) {
      // Get post author and liker info
      if (post.authorId !== userId) {
        // Send in-app notification (non-blocking)
        notificationService.notifyPostLike(
          post.authorId,
          userId,
          liker?.name || 'Someone',
          postId
        ).catch(console.error);
      }
    }

    res.json({ liked, likesCount });
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

    if (!post) {
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
            rooms: [FEED_REALTIME_ROOM, `post:${postId}`],
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
        tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
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

// Get comments
export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const currentUserId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const parentId = ensureString(req.query.parentId) || undefined;
    const page = Math.max(1, parseInt(ensureString(req.query.page) || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(ensureString(req.query.limit) || '20', 10)));

    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const where = { postId: postId as string, parentId: parentId || null };
    const [comments, total] = await Promise.all([
      prismaRead.post_comments.findMany({
        where,
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
            },
          },
          _count: { select: { other_post_comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit + 1,
      }),
      prismaRead.post_comments.count({ where }),
    ]);

    // Fetch current user's likes for these comments (separate query to avoid filtered relation issues)
    const commentIds = comments.map((c) => c.id);
    const userLikes = commentIds.length > 0
      ? await prismaRead.comment_likes.findMany({
          where: { commentId: { in: commentIds }, userId: currentUserId },
          select: { commentId: true },
        })
      : [];
    const likedCommentIds = new Set(userLikes.map((l) => l.commentId));

    const hasMore = comments.length > limit;
    const items = hasMore ? comments.slice(0, limit) : comments;
    
    // Fetch replies for top-level comments (only if not fetching replies specifically)
    const topLevelCommentIds = items.map((c) => c.id);
    let repliesMap: Map<string, typeof items> = new Map();
    
    if (!parentId && topLevelCommentIds.length > 0) {
      const replies = await prismaRead.post_comments.findMany({
        where: { postId: postId as string, parentId: { in: topLevelCommentIds } },
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
            },
          },
          _count: { select: { other_post_comments: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100, // Limit total replies fetched
      });
      
      // Get likes for replies too
      const replyIds = replies.map((r) => r.id);
      if (replyIds.length > 0) {
        const replyLikes = await prismaRead.comment_likes.findMany({
          where: { commentId: { in: replyIds }, userId: currentUserId },
          select: { commentId: true },
        });
        replyLikes.forEach((l) => likedCommentIds.add(l.commentId));
      }
      
      // Group replies by parent
      replies.forEach((r) => {
        if (r.parentId) {
          const existing = repliesMap.get(r.parentId) || [];
          existing.push(r);
          repliesMap.set(r.parentId, existing);
        }
      });
    }
    
    // Helper to map a comment
    const mapComment = (c: typeof items[0], includeReplies: boolean = false): Record<string, unknown> => {
      const cWithRelations = c as typeof c & { users: unknown; _count: { other_post_comments: number } };
      const author = cWithRelations.users ?? {
        id: c.authorId,
        username: 'unknown',
        name: 'Unknown User',
        profileImage: null,
      };
      
      const mapped: Record<string, unknown> = {
        id: c.id,
        postId: c.postId,
        parentId: c.parentId,
        authorId: c.authorId,
        author,
        content: c.content,
        contentType: 'text/plain',
        mentions: [],
        likesCount: c.likesCount,
        replyCount: cWithRelations._count?.other_post_comments ?? 0,
        isLiked: likedCommentIds.has(c.id),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
      
      if (includeReplies && repliesMap.has(c.id)) {
        mapped.replies = repliesMap.get(c.id)!.map((r) => mapComment(r, false));
      } else {
        mapped.replies = [];
      }
      
      return mapped;
    };

    const mapped = items.map((c) => mapComment(c, !parentId));

    res.json({ comments: mapped, total, hasMore });
  } catch (error) {
    const err = error as Error;
    console.error('getComments error:', err?.message ?? error);
    console.error('getComments stack:', err?.stack);
    const message = process.env.NODE_ENV !== 'production' && err?.message
      ? err.message
      : 'Failed to fetch comments';
    res.status(500).json({ error: message });
  }
};

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
      select: { id: true, authorId: true },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const { comment, commentsCount, mapped } = await prisma.$transaction(async (tx) => {
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
        {
          event: 'comment:created',
          rooms: [FEED_REALTIME_ROOM],
          payload: {
            postId,
            commentsCount: nextCommentsCount,
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
        tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
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
    recordActivity(userId, 'comment', 1).catch(console.error);

    res.status(201).json(mapped);
  } catch (error) {
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
      select: { authorId: true },
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
            rooms: [`post:${postId}`, FEED_REALTIME_ROOM],
            payload: { postId, commentId, commentsCount: nextCommentsCount },
          },
        ],
      });

      await enqueueCacheInvalidation(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.comment.deleted.cache.invalidate',
        tags: [`feed:${postRecord?.authorId || userId}`, `user:${postRecord?.authorId || userId}`],
      });

      return nextCommentsCount;
    });

    res.json({ success: true, commentsCount });
  } catch (error) {
    console.error('deleteComment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

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
      select: { id: true, authorId: true, sharesCount: true },
    });
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const sharesCount = await prisma.$transaction(async (tx) => {
      const nextSharesCount = (post.sharesCount || 0) + 1;
      await tx.post.update({
        where: { id: postId },
        data: { sharesCount: nextSharesCount },
      });

      await enqueueRealtimeFanout(tx as any, {
        aggregateType: 'post',
        aggregateId: postId,
        eventType: 'post.shared',
        envelopes: [
          {
            event: 'post:shared',
            rooms: [FEED_REALTIME_ROOM, `post:${postId}`],
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
        tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
      });

      return nextSharesCount;
    });

    const frontendUrl = process.env.FRONTEND_URL || 'https://vormex.com';
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

// Get post likes list
export const getLikes = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const postId = ensureString(req.params.postId);
    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
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
          reactionType: 'LIKE',
          createdAt: like.createdAt,
        };
      }),
    });
  } catch (error) {
    console.error('getLikes error:', error);
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
};
