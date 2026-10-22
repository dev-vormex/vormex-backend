import { Response } from "express";
import { bunnyStreamService } from "../../../../infrastructure/media/bunny-stream.service";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";
import { prisma, JOIN_RELATIONS } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { recordActivity } from "../../../engagement/services/activity.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { AuthRequest, safeJsonParse, reelInclude, invalidateReelsFeedCache, mapReelResponse } from "./support.controller";

export const createReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const files = req.files as { video?: Express.Multer.File[]; thumbnail?: Express.Multer.File[] } | undefined;
    const file = (files?.video?.[0] || (req as any).file) as Express.Multer.File | undefined;

    if (!file) {
      res.status(400).json({ error: 'Video file is required' });
      return;
    }

    let videoId: string;
    let videoUrl: string;
    let hlsUrl: string | null;
    let thumbnailUrl: string;
    let previewGifUrl: string;

    const useBunnyStream = !!(
      process.env.BUNNY_STREAM_API_KEY &&
      process.env.BUNNY_STREAM_LIBRARY_ID &&
      process.env.BUNNY_STREAM_CDN_HOSTNAME
    );

    let usedBunnyStream = false;

    if (useBunnyStream) {
      try {
        const title = `reel_${userId}_${Date.now()}`;
        const created = await bunnyStreamService.createVideo(title);
        videoId = created.videoId;
        await bunnyStreamService.uploadVideo(videoId, file.buffer);
        videoUrl = bunnyStreamService.getMp4Url(videoId);
        hlsUrl = bunnyStreamService.getHlsUrl(videoId);
        thumbnailUrl = bunnyStreamService.getThumbnailUrl(videoId);
        previewGifUrl = bunnyStreamService.getPreviewUrl(videoId);
        usedBunnyStream = true;
      } catch (streamErr: any) {
        console.warn('Bunny Stream failed, falling back to Bunny Storage:', streamErr.message);
        videoId = `storage_${userId}_${Date.now()}`;
        videoUrl = await bunnyStorageService.uploadPostVideo(file.buffer, userId, file.mimetype);
        hlsUrl = null;
        thumbnailUrl = '';
        previewGifUrl = '';
      }
    } else {
      videoId = `storage_${userId}_${Date.now()}`;
      videoUrl = await bunnyStorageService.uploadPostVideo(file.buffer, userId, file.mimetype);
      hlsUrl = null;
      thumbnailUrl = '';
      previewGifUrl = '';
    }

    // Custom thumbnail (overrides Bunny Stream thumbnail when provided)
    const thumbnailFile = files?.thumbnail?.[0];
    if (thumbnailFile && thumbnailFile.mimetype.startsWith('image/')) {
      try {
        thumbnailUrl = await bunnyStorageService.uploadReelThumbnail(
          thumbnailFile.buffer,
          userId,
          thumbnailFile.mimetype
        );
      } catch (err) {
        console.warn('Failed to upload custom thumbnail:', err);
      }
    }

    const isDraft = req.body.saveAsDraft === 'true';
    const scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    const originalReelId = req.body.originalReelId || null;
    const responseType = req.body.responseType || null; // 'duet' | 'stitch'

    const reel = await prisma.reels.create({
      data: {
        id: randomUUID(),
        authorId: userId,
        videoId,
        videoUrl,
        hlsUrl,
        thumbnailUrl: thumbnailUrl || null,
        previewGifUrl: previewGifUrl || null,
        durationSeconds: 0,
        title: req.body.title || null,
        caption: req.body.caption || null,
        hashtags: safeJsonParse<string[]>(req.body.hashtags, []),
        mentions: safeJsonParse<string[]>(req.body.mentions, []),
        skills: safeJsonParse<string[]>(req.body.skills, []),
        topics: safeJsonParse<string[]>(req.body.topics, []),
        category: req.body.category || null,
        visibility: req.body.visibility || 'public',
        allowComments: req.body.allowComments !== 'false',
        allowDuets: req.body.allowDuets !== 'false',
        allowStitch: req.body.allowStitch !== 'false',
        allowDownload: req.body.allowDownload !== 'false',
        allowSharing: req.body.allowSharing !== 'false',
        codeSnippet: req.body.codeSnippet || null,
        codeLanguage: req.body.codeLanguage || null,
        codeFileName: req.body.codeFileName || null,
        repoUrl: req.body.repoUrl || null,
        status: isDraft ? 'draft' : usedBunnyStream ? 'processing' : 'ready',
        publishedAt: !isDraft && !usedBunnyStream ? new Date() : null,
        scheduledAt,
        originalReelId,
        isResponse: !!originalReelId,
        responseType,
        audioId: req.body.audioId || null,
        audioStartTime: parseInt(req.body.audioStartTime || '0', 10),
        muteOriginalAudio: req.body.muteOriginalAudio === 'true',
        updatedAt: new Date(),
      },
      include: reelInclude(userId),
    });

    recordActivity(userId, 'short_video', 1, { sourceId: reel.id }).catch(console.error);
    if (reel.status === 'ready' && reel.visibility === 'public') {
      invalidateReelsFeedCache();
    }

    res.status(201).json(mapReelResponse(reel, userId));
  } catch (error: any) {
    console.error('createReel error:', error);
    const message = error?.response?.data?.message || error?.message || 'Failed to create reel';
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      res.status(status).json({ error: message });
    } else if (error?.response?.data?.error) {
      res.status(status || 500).json({ error: error.response.data.error, message: error.response.data.message });
    } else {
      res.status(500).json({ error: 'Failed to create reel', message: process.env.NODE_ENV === 'development' ? message : undefined });
    }
  }
};

export const updateReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const existing = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only edit your own reels' });
      return;
    }

    const updateData: any = {};
    const allowedFields = [
      'title',
      'caption',
      'hashtags',
      'mentions',
      'skills',
      'topics',
      'category',
      'visibility',
      'allowComments',
      'allowDuets',
      'allowStitch',
      'allowDownload',
      'allowSharing',
      'scheduledAt',
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
        if (field === 'scheduledAt' && req.body[field]) {
          updateData[field] = new Date(req.body[field]);
        }
      }
    }

    const reel = await prisma.reels.update({
      where: { id: reelId },
      data: updateData,
      include: reelInclude(userId),
    });

    invalidateReelsFeedCache();
    res.json(mapReelResponse(reel, userId));
  } catch (error) {
    console.error('updateReel error:', error);
    res.status(500).json({ error: 'Failed to update reel' });
  }
};

export const publishDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { scheduledAt } = req.body;

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, status: true },
    });

    if (!reel) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (reel.authorId !== userId) {
      res.status(403).json({ error: 'You can only publish your own reels' });
      return;
    }

    if (reel.status !== 'draft') {
      res.status(400).json({ error: 'Only drafts can be published' });
      return;
    }

    const publishAt = scheduledAt ? new Date(scheduledAt) : new Date();
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    await prisma.reels.update({
      where: { id: reelId },
      data: {
        status: 'ready',
        visibility: 'public',
        scheduledAt: isScheduled ? publishAt : null,
        publishedAt: isScheduled ? null : publishAt,
      },
    });

    invalidateReelsFeedCache();
    const updated = await prisma.reels.findUnique({
      where: { id: reelId },
      include: reelInclude(userId),
      relationLoadStrategy: JOIN_RELATIONS,
    });

    res.json(mapReelResponse(updated!, userId));
  } catch (error) {
    console.error('publishDraft error:', error);
    res.status(500).json({ error: 'Failed to publish draft' });
  }
};

export const deleteReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const existing = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true, videoId: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    if (existing.authorId !== userId) {
      res.status(403).json({ error: 'You can only delete your own reels' });
      return;
    }

    await prisma.reels.delete({ where: { id: reelId } });
    invalidateReelsFeedCache();
    bunnyStreamService.deleteVideo(existing.videoId).catch(console.error);

    res.json({ success: true });
  } catch (error) {
    console.error('deleteReel error:', error);
    res.status(500).json({ error: 'Failed to delete reel' });
  }
};
