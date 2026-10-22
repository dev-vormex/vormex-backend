/**
 * Scheduled Publish Service
 * Publishes reels when their scheduledAt time has passed
 */

import { prisma } from '../../../config/prisma';


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
