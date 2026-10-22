import { Response } from "express";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";
import { parseStoredMusicAttachment } from "../../utils/music.util";
import { prisma } from "../../../../config/prisma";
import crypto from "crypto";
import { getIO } from "../../../../realtime/socket-registry";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { getConnectedPeerIds, buildStoryVisibilityWhere } from "../../../../shared/utils/access-control.util";
import { ensureString } from "../../../../shared/utils/request.util";
import { AuthRequest, STORY_EXPIRY_HOURS, normalizeStoryVisibility, mapStoryToResponse, invalidateStoryFeedCaches } from "./support.controller";

// Create story
export const createStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const expiresAt = new Date(Date.now() + STORY_EXPIRY_HOURS * 60 * 60 * 1000);
    let mediaType = 'TEXT';
    let mediaUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    let textContent: string | null = null;
    let backgroundColor: string | null = null;
    let category = 'GENERAL';
    let visibility = 'PUBLIC';
    let linkUrl: string | null = null;
    let linkTitle: string | null = null;
    let musicMetadata: any = null;

    // Handle FormData (media upload)
    const file = req.file as Express.Multer.File | undefined;
    if (file) {
      const isVideo = file.mimetype?.startsWith('video/');
      const isImage = file.mimetype?.startsWith('image/');
      if (isVideo) {
        mediaType = 'VIDEO';
        mediaUrl = await bunnyStorageService.uploadStoryVideo(file.buffer, userId, file.mimetype || 'video/mp4');
        thumbnailUrl = mediaUrl;
      } else if (isImage) {
        mediaType = 'IMAGE';
        mediaUrl = await bunnyStorageService.uploadStoryImage(file.buffer, userId, file.mimetype || 'image/jpeg');
        thumbnailUrl = mediaUrl;
      } else {
        res.status(400).json({ error: 'Invalid file type. Use image or video.' });
        return;
      }
      textContent = (req.body.textContent as string) || null;
      category = (req.body.category as string) || 'GENERAL';
      visibility = normalizeStoryVisibility(req.body.visibility);
      linkUrl = (req.body.linkUrl as string) || null;
      linkTitle = (req.body.linkTitle as string) || null;
      musicMetadata = parseStoredMusicAttachment(req.body.music);
    } else {
      // JSON body (text-only story)
      const body = req.body as Record<string, any>;
      mediaType = (body.mediaType as string) || 'TEXT';
      textContent = (body.textContent as string) || null;
      backgroundColor = (body.backgroundColor as string) || null;
      category = (body.category as string) || 'GENERAL';
      visibility = normalizeStoryVisibility(body.visibility);
      linkUrl = (body.linkUrl as string) || null;
      linkTitle = (body.linkTitle as string) || null;
      musicMetadata = parseStoredMusicAttachment(body.music);

      if (!textContent && mediaType === 'TEXT') {
        res.status(400).json({ error: 'Text content is required for text stories' });
        return;
      }
    }

    const story = await prisma.stories.create({
      data: {
        id: crypto.randomUUID(),
        authorId: userId,
        mediaType,
        mediaUrl,
        thumbnailUrl,
        textContent,
        backgroundColor,
        category,
        visibility,
        linkUrl,
        linkTitle,
        musicMetadata,
        expiresAt,
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
      },
    });

    const storyData = mapStoryToResponse(story, userId);

    // Emit real-time event for story carousel
    const io = getIO();
    if (io) {
      const storyCreatedPayload = {
        story: storyData,
        author: (story as any).users,
        timestamp: story.createdAt,
      };

      io.to(`user:${userId}`).emit('story:created', storyCreatedPayload);
      if (visibility === 'PUBLIC') {
        const blockedUserIds = new Set(await getBlockedUserIds(userId));
        const sockets = await io.fetchSockets();
        const recipientIds = new Set(
          sockets
            .map((socket) => String(socket.data?.userId || ''))
            .filter((recipientId) => recipientId && recipientId !== userId && !blockedUserIds.has(recipientId))
        );
        recipientIds.forEach((recipientId) => {
          io.to(`user:${recipientId}`).emit('story:created', storyCreatedPayload);
        });
      } else if (visibility === 'CONNECTIONS') {
        const blockedUserIds = new Set(await getBlockedUserIds(userId));
        const peerIds = (await getConnectedPeerIds(userId)).filter((peerId) => !blockedUserIds.has(peerId));
        peerIds.forEach((peerId) => {
          io.to(`user:${peerId}`).emit('story:created', storyCreatedPayload);
        });
      }
    }

    await invalidateStoryFeedCaches('stories:feed:global', `stories:${userId}`);
    res.status(201).json({ message: 'Story created', story: storyData });
  } catch (error) {
    console.error('createStory error:', error);
    res.status(500).json({ error: 'Failed to create story' });
  }
};

// Get single story
export const getStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }

    const story = await prisma.stories.findFirst({
      where: {
        id: storyId,
        expiresAt: { gt: new Date() },
        ...(await buildStoryVisibilityWhere(currentUserId)),
      },
      include: {
        users: { select: { id: true, username: true, name: true, profileImage: true, headline: true } },
        ...(currentUserId
          ? {
              story_views: {
                where: { viewerId: currentUserId },
                select: { viewerId: true },
                take: 1,
              },
            }
          : {}),
        _count: {
          select: {
            story_views: true,
          },
        },
      },
    });

    if (!story) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    res.json({ story: mapStoryToResponse(story, currentUserId), isOwn: story.authorId === currentUserId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch story' });
  }
};

// Delete story
export const deleteStory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const storyId = ensureString(req.params.storyId);
    if (!storyId) {
      res.status(400).json({ error: 'Story ID is required' });
      return;
    }

    const story = await prisma.stories.findFirst({ where: { id: storyId } });
    if (!story) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    if (story.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own stories' });
      return;
    }

    await prisma.stories.delete({ where: { id: storyId } });

    const io = getIO();
    if (io) {
      io.emit('story:deleted', { storyId, authorId: userId, timestamp: new Date() });
    }

    await invalidateStoryFeedCaches('stories:feed:global', `stories:${userId}`);
    res.json({ message: 'Story deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete story' });
  }
};

// Archive story
export const archiveStory = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const storyId = ensureString(req.params.storyId);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!storyId) {
    res.status(400).json({ error: 'Story ID is required' });
    return;
  }
  const story = await prisma.stories.findFirst({ where: { id: storyId, authorId: userId }, select: { id: true } });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ message: 'Story archived' });
};

// Get archived stories
export const getArchivedStories = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ stories: [] });
};
