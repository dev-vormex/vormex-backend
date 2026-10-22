import { Request, Response } from "express";
import { prisma } from "../../../../config/prisma";
import { bunnyStreamService } from "../../../../infrastructure/media/bunny-stream.service";
import { getIO } from "../../../../realtime/socket-registry";
import { verifyBunnyStreamSignature, invalidateReelCacheTags } from "./support.controller";

export const transcodingWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!verifyBunnyStreamSignature(req)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    const { VideoGuid, Status, LibraryId } = req.body;

    if (LibraryId !== process.env.BUNNY_STREAM_LIBRARY_ID) {
      res.status(400).json({ error: 'Invalid library ID' });
      return;
    }

    const reelRecord = await prisma.reels.findUnique({
      where: { videoId: VideoGuid },
      select: { id: true, authorId: true, status: true, scheduledAt: true },
    });

    if (!reelRecord) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const statusString = bunnyStreamService.getStatusString(Status);

    if (statusString === 'ready') {
      const videoInfo = await bunnyStreamService.getVideo(VideoGuid);
      const now = new Date();
      const isDraft = reelRecord.status === 'draft';
      const hasScheduledFuture = reelRecord.scheduledAt && new Date(reelRecord.scheduledAt) > now;
      const shouldPublish = !isDraft && !hasScheduledFuture;

      await prisma.reels.update({
        where: { id: reelRecord.id },
        data: {
          status: 'ready',
          transcodingProgress: 100,
          durationSeconds: Math.round(videoInfo.length || 0),
          width: videoInfo.width || 1080,
          height: videoInfo.height || 1920,
          fileSize: videoInfo.storageSize,
          ...(shouldPublish ? { publishedAt: now } : {}),
        },
      });

      const io = getIO();
      if (io) {
        io.to(`user:${reelRecord.authorId}`).emit('reel:processing_complete', {
          reelId: reelRecord.id,
          hlsUrl: bunnyStreamService.getHlsUrl(VideoGuid),
        });
      }
      invalidateReelCacheTags(reelRecord);
    } else if (statusString === 'failed') {
      await prisma.reels.update({
        where: { id: reelRecord.id },
        data: {
          status: 'failed',
          processingError: 'Transcoding failed',
        },
      });

      const io = getIO();
      if (io) {
        io.to(`user:${reelRecord.authorId}`).emit('reel:processing_failed', {
          reelId: reelRecord.id,
          error: 'Transcoding failed',
        });
      }
      invalidateReelCacheTags(reelRecord);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('transcodingWebhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
};
