import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { AuthRequest, viewBatch, viewBatchItemCount, VIEW_BATCH_MAX_ITEMS, viewBatchTimeout, incrementViewBatchItemCount, setViewBatchTimeout, flushViewBatch } from "./support.controller";

export const trackView = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { watchTimeMs, completed, source } = req.body;

    if (watchTimeMs < 3000) {
      res.json({ success: true });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: { authorId: true, visibility: true, status: true, publishedAt: true },
    });

    if (!reel || !(await canViewReel(reel, userId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const reelViews = viewBatch.get(reelId) || [];
    reelViews.push({
      reelId,
      userId,
      watchTimeMs: watchTimeMs || 0,
      completed: completed || false,
      source,
    });
    viewBatch.set(reelId, reelViews);
    incrementViewBatchItemCount();

    if (viewBatchItemCount >= VIEW_BATCH_MAX_ITEMS) {
      if (viewBatchTimeout) {
        clearTimeout(viewBatchTimeout);
        setViewBatchTimeout(null);
      }
      setImmediate(() => flushViewBatch().catch(console.error));
    } else if (!viewBatchTimeout) {
      setViewBatchTimeout(setTimeout(() => {
        setViewBatchTimeout(null);
        flushViewBatch().catch(console.error);
      }, 5000));
    }

    res.json({ success: true });
  } catch (error) {
    console.error('trackView error:', error);
    res.status(500).json({ error: 'Failed to track view' });
  }
};
