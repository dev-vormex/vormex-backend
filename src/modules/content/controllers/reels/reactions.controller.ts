import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { getIO } from "../../../../realtime/socket-registry";
import { notificationService } from "../../../notifications/services/notification.service";
import { recordAuthoritativeRecommendationOutcome } from "../../../discovery/services/recommendation-platform.service";
import { AuthRequest, isUniqueViolation } from "./support.controller";

export const toggleLike = async (req: AuthRequest, res: Response): Promise<void> => {
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

    const [reel, user] = await Promise.all([
      prisma.reels.findUnique({
        where: { id: reelId },
        select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true, likesCount: true },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, username: true },
      }),
    ]);

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const existingLike = await prisma.reel_likes.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    let liked = false;
    let likesCount = reel.likesCount || 0;
    if (existingLike) {
      const result = await prisma.$transaction(async (tx) => {
        const deleted = await tx.reel_likes.deleteMany({
          where: { reelId, userId },
        });
        if (deleted.count !== 1) {
          const current = await tx.reels.findUnique({
            where: { id: reelId },
            select: { likesCount: true },
          });
          return { liked: false, likesCount: current?.likesCount || 0 };
        }

        const updatedReel = await tx.reels.update({
          where: { id: reelId },
          data: { likesCount: { decrement: 1 } },
          select: { likesCount: true },
        });
        return { liked: false, likesCount: updatedReel.likesCount };
      });
      liked = result.liked;
      likesCount = result.likesCount;
    } else {
      try {
        const result = await prisma.$transaction(async (tx) => {
          await tx.reel_likes.create({
            data: { reelId, userId },
          });
          const updatedReel = await tx.reels.update({
            where: { id: reelId },
            data: { likesCount: { increment: 1 } },
            select: { likesCount: true },
          });
          return { liked: true, likesCount: updatedReel.likesCount };
        });
        liked = result.liked;
        likesCount = result.likesCount;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        liked = true;
        const current = await prisma.reels.findUnique({
          where: { id: reelId },
          select: { likesCount: true },
        });
        likesCount = current?.likesCount || 0;
      }
    }

    const io = getIO();
    if (io) {
      // Broadcast to reel room for real-time updates
      io.to(`reel:${reelId}`).emit('reel:engagement_update', { 
        reelId, 
        type: 'like',
        userId, 
        liked, 
        likesCount 
      });
    }

    // Send notification for likes (persisted)
    if (liked && reel.authorId !== userId && user) {
      notificationService.notifyReelLike(
        reel.authorId,
        userId,
        user.name || user.username,
        reelId
      );
    }

    if (liked) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'REACTION', meaningfulOutcome: false,
    }).catch(() => undefined);

    res.json({ liked, likesCount });
  } catch (error) {
    console.error('toggleLike error:', error);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
};

export const toggleSave = async (req: AuthRequest, res: Response): Promise<void> => {
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

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const existingSave = await prisma.reel_saves.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    let saved = false;
    if (existingSave) {
      await prisma.reel_saves.delete({
        where: { reelId_userId: { reelId, userId } },
      });
    } else {
      await prisma.reel_saves.create({
        data: { reelId, userId },
      });
      saved = true;
    }

    const savesCount = await prisma.reel_saves.count({ where: { reelId } });
    await prisma.reels.update({
      where: { id: reelId },
      data: { savesCount },
    });

    if (saved) void recordAuthoritativeRecommendationOutcome({
      userId, entityType: 'REEL', entityId: reelId, eventType: 'SAVE', meaningfulOutcome: true,
    }).catch(() => undefined);

    res.json({ saved, savesCount });
  } catch (error) {
    console.error('toggleSave error:', error);
    res.status(500).json({ error: 'Failed to toggle save' });
  }
};
