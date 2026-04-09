/**
 * Scheduled Publish Service
 * Publishes reels when their scheduledAt time has passed
 */

import { prisma } from '../config/prisma';
import { isPrismaConnectionError } from '../utils/prisma-error.util';

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
let intervalId: NodeJS.Timeout | null = null;
let warnedDbUnavailable = false;

export async function publishScheduledReels(): Promise<number> {
  const now = new Date();

  const result = await prisma.reels.updateMany({
    where: {
      status: 'ready',
      scheduledAt: { lte: now, not: null },
      publishedAt: null,
    },
    data: { publishedAt: now },
  });

  return result.count;
}

export function startScheduledPublishScheduler(): void {
  if (intervalId) return;

  intervalId = setInterval(async () => {
    try {
      const count = await publishScheduledReels();
      if (warnedDbUnavailable) {
        console.log('[ScheduledPublish] Database connection recovered');
        warnedDbUnavailable = false;
      }
      if (count > 0) {
        console.log(`[ScheduledPublish] Published ${count} scheduled reel(s)`);
      }
    } catch (error) {
      if (isPrismaConnectionError(error)) {
        if (!warnedDbUnavailable) {
          warnedDbUnavailable = true;
          console.warn(
            '[ScheduledPublish] Database is temporarily unavailable (likely waking up). ' +
            'Will retry automatically.'
          );
        }
        return;
      }
      console.error('[ScheduledPublish] Error:', error);
    }
  }, CHECK_INTERVAL_MS);

  console.log('[ScheduledPublish] Scheduler started');
}

export function stopScheduledPublishScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[ScheduledPublish] Scheduler stopped');
  }
}
