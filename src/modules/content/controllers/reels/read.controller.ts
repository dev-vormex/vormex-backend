import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma, JOIN_RELATIONS } from "../../../../config/prisma";
import { buildReelVisibilityWhere, canViewReel } from "../../../../shared/utils/access-control.util";
import { AuthRequest, reelInclude, mapReelResponse } from "./support.controller";

export const getReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);

    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findFirst({
      where: {
        id: reelId,
        ...(await buildReelVisibilityWhere(currentUserId, { allowOwnerDraft: true })),
      },
      include: reelInclude(currentUserId),
      relationLoadStrategy: JOIN_RELATIONS,
    });

    if (!reel) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    res.json(mapReelResponse(reel, currentUserId));
  } catch (error) {
    console.error('getReel error:', error);
    res.status(500).json({ error: 'Failed to fetch reel' });
  }
};

export const getReelPreloadData = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const reelId = ensureString(req.params.reelId);

    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        visibility: true,
        hlsUrl: true,
        videoUrl: true,
        thumbnailUrl: true,
        durationSeconds: true,
        status: true,
        publishedAt: true,
      },
    });

    if (!reel || !(await canViewReel(reel, req.user?.userId))) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    res.json({
      hlsUrl: reel.hlsUrl,
      videoUrl: reel.videoUrl,
      thumbnailUrl: reel.thumbnailUrl,
      durationSeconds: reel.durationSeconds,
    });
  } catch (error) {
    console.error('getReelPreloadData error:', error);
    res.status(500).json({ error: 'Failed to fetch preload data' });
  }
};

/** Get reel's audio for "Use this audio" / Remix flow */
export const getReelAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        id: true,
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        audioId: true,
        reel_audio: {
          select: {
            id: true,
            title: true,
            artist: true,
            albumArt: true,
            audioUrl: true,
            durationMs: true,
            genre: true,
            originalReelId: true,
            usageCount: true,
          },
        },
        users: { select: { id: true, username: true, name: true } },
      },
    });

    if (!reel || !(await canViewReel(reel, req.user?.userId))) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    const reelWithAudio = reel as typeof reel & { reel_audio: { id: string; title: string; artist: string; albumArt: string | null; audioUrl: string | null; durationMs: number | null; genre: string | null; originalReelId: string | null; usageCount: number } | null; users: { id: string; username: string; name: string } };
    if (!reelWithAudio.reel_audio) {
      res.json({
        hasAudio: false,
        message: 'This reel uses original audio',
        audio: null,
      });
      return;
    }

    res.json({
      hasAudio: true,
      audio: {
        id: reelWithAudio.reel_audio.id,
        title: reelWithAudio.reel_audio.title,
        artist: reelWithAudio.reel_audio.artist,
        albumArt: reelWithAudio.reel_audio.albumArt,
        audioUrl: reelWithAudio.reel_audio.audioUrl,
        durationMs: reelWithAudio.reel_audio.durationMs,
        genre: reelWithAudio.reel_audio.genre,
        usageCount: reelWithAudio.reel_audio.usageCount,
        sourceReelId: reel.id,
        originalCreator: reelWithAudio.reel_audio.originalReelId ? reelWithAudio.users : null,
      },
    });
  } catch (error) {
    console.error('getReelAudio error:', error);
    res.status(500).json({ error: 'Failed to fetch reel audio' });
  }
};
