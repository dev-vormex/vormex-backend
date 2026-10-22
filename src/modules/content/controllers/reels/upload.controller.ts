import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { createStorageUploadIntent, createBunnyStreamUploadIntent, validateFinalizedStreamMedia, validateFinalizedStorageMedia } from "../../utils/direct-media-upload.util";
import { bunnyStreamService } from "../../../../infrastructure/media/bunny-stream.service";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { recordActivity } from "../../../engagement/services/activity.service";
import { AuthRequest, pickReelUploadMetadata, reelInclude, invalidateReelsFeedCache, mapReelResponse } from "./support.controller";

export const getUploadUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const mimeType = ensureString(req.body?.mimeType);
    const sizeBytes = Number(req.body?.sizeBytes);
    const uploadKind = ensureString(req.body?.uploadKind) || 'video';

    if (!mimeType || !Number.isFinite(sizeBytes)) {
      res.status(400).json({ error: 'mimeType and sizeBytes are required' });
      return;
    }

    if (uploadKind === 'thumbnail') {
      const credential = createStorageUploadIntent({
        userId: req.user.userId,
        purpose: 'reel_thumbnail',
        mimeType,
        sizeBytes,
      });

      res.json({
        provider: 'bunny_storage',
        uploadMethod: 'PUT',
        uploadUrl: credential.uploadUrl,
        uploadHeaders: credential.headers,
        objectKey: credential.objectKey,
        cdnUrl: credential.cdnUrl,
        uploadToken: credential.token,
        expiresAt: credential.intent.expiresAt,
        maxBytes: credential.intent.maxBytes,
        mimeType,
      });
      return;
    }

    const title = `reel_${req.user.userId}_${Date.now()}`;
    const { videoId, uploadUrl } = await bunnyStreamService.createVideo(title);
    const credential = createBunnyStreamUploadIntent({
      userId: req.user.userId,
      videoId,
      mimeType,
      sizeBytes,
    });

    res.json({
      provider: 'bunny_stream',
      uploadMethod: 'TUS',
      videoId,
      uploadUrl: credential.uploadUrl,
      uploadHeaders: credential.headers,
      uploadToken: credential.token,
      expiresAt: credential.intent.expiresAt,
      maxBytes: credential.intent.maxBytes,
      mimeType,
      legacyUploadUrl: uploadUrl,
    });
  } catch (error) {
    console.error('getUploadUrl error:', error);
    const message = error instanceof Error ? error.message : 'Failed to get upload URL';
    res.status(message.includes('large') || message.includes('Unsupported') ? 400 : 500).json({ error: message });
  }
};

export const onUploadComplete = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const {
      videoId,
      title,
      caption,
      hashtags,
      visibility,
      uploadToken,
      mimeType,
      sizeBytes,
      thumbnail,
      ...metadata
    } = req.body;

    if (!videoId || !uploadToken || !mimeType || !Number.isFinite(Number(sizeBytes))) {
      res.status(400).json({ error: 'videoId, uploadToken, mimeType, and sizeBytes are required' });
      return;
    }

    validateFinalizedStreamMedia({
      userId,
      token: String(uploadToken),
      videoId: String(videoId),
      mimeType: String(mimeType),
      sizeBytes: Number(sizeBytes),
    });

    const videoInfo = await bunnyStreamService.getVideo(String(videoId)).catch(() => null);
    if (videoInfo?.storageSize && Number(videoInfo.storageSize) > Number(sizeBytes)) {
      res.status(400).json({ error: 'Uploaded video size does not match the issued credential' });
      return;
    }

    let thumbnailUrl = bunnyStreamService.getThumbnailUrl(videoId);
    if (thumbnail?.objectKey && thumbnail?.uploadToken && thumbnail?.mimeType && thumbnail?.sizeBytes) {
      try {
        thumbnailUrl = await validateFinalizedStorageMedia({
          userId,
          token: String(thumbnail.uploadToken),
          objectKey: String(thumbnail.objectKey),
          mimeType: String(thumbnail.mimeType),
          sizeBytes: Number(thumbnail.sizeBytes),
          purpose: 'reel_thumbnail',
        });
      } catch (thumbnailError) {
        res.status(400).json({
          error: thumbnailError instanceof Error ? thumbnailError.message : 'Invalid thumbnail upload',
        });
        return;
      }
    }

    const isDraft = metadata.saveAsDraft === true;
    const scheduledAt = metadata.scheduledAt ? new Date(metadata.scheduledAt as string) : null;
    const originalReelId = metadata.originalReelId as string | null || null;
    const responseType = metadata.responseType as string | null || null;

    const reel = await prisma.reels.create({
      data: {
        id: randomUUID(),
        authorId: userId,
        videoId,
        videoUrl: bunnyStreamService.getMp4Url(videoId),
        hlsUrl: bunnyStreamService.getHlsUrl(videoId),
        thumbnailUrl,
        previewGifUrl: bunnyStreamService.getPreviewUrl(videoId),
        durationSeconds: metadata.durationSeconds || 0,
        width: metadata.width || videoInfo?.width || 1080,
        height: metadata.height || videoInfo?.height || 1920,
        fileSize: Number(sizeBytes),
        title: title || null,
        caption: caption || null,
        hashtags: hashtags || [],
        visibility: visibility || 'public',
        status: isDraft ? 'draft' : 'processing',
        scheduledAt,
        originalReelId,
        isResponse: !!originalReelId,
        responseType,
        audioId: metadata.audioId as string | null || null,
        audioStartTime: parseInt(String(metadata.audioStartTime || 0), 10),
        muteOriginalAudio: metadata.muteOriginalAudio === true,
        ...pickReelUploadMetadata(metadata),
        updatedAt: new Date(),
      },
      include: reelInclude(userId),
    });

    recordActivity(userId, 'short_video', 1, { sourceId: reel.id }).catch(console.error);
    if (reel.status === 'ready' && reel.visibility === 'public') {
      invalidateReelsFeedCache();
    }

    res.status(201).json(mapReelResponse(reel, userId));
  } catch (error) {
    console.error('onUploadComplete error:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
};
