import { prisma } from '../config/prisma';
import { proximitySummaryCounter } from '../infrastructure/metrics/registry';
import { getProximityFeatureFlagsForUser } from './proximity-feature-flags.service';

export async function generateProximitySummary(sessionId: string) {
  const session = await prisma.proximity_sessions.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  if (session.summaryReadyAt) return session;
  const endedAt = session.endedAt || new Date();
  const count = await prisma.proximity_encounter_pairs.count({ where: {
    expiresAt: { gt: new Date() }, firstSeenAt: { lte: endedAt }, lastSeenAt: { gte: session.startedAt },
    OR: [{ lowerUserId: session.userId }, { higherUserId: session.userId }],
  } });
  const summary = await prisma.proximity_sessions.update({ where: { id: session.id }, data: {
    summaryCount: count, summaryStatus: 'ready', summaryReadyAt: new Date(),
  }});
  proximitySummaryCounter.inc({ outcome: 'generated' });
  if (getProximityFeatureFlagsForUser(session.userId).summaryNotifications) {
    const preference = await prisma.proximity_preferences.findUnique({ where: { userId: session.userId },
      select: { summaryNotificationsEnabled: true } });
    if (preference?.summaryNotificationsEnabled !== false) {
      try {
        const { pushNotificationService } = await import('./push-notification.service');
        const delivered = await pushNotificationService.sendToUser(session.userId, {
          title: 'Event complete',
          body: `${count} people crossed paths with you`,
          data: { type: 'crossed_paths_summary', screen: 'crossed_paths', sessionId: session.id, count: String(count) },
        });
        proximitySummaryCounter.inc({ outcome: delivered ? 'delivered' : 'delivery_unavailable' });
      } catch {
        proximitySummaryCounter.inc({ outcome: 'delivery_failed' });
      }
    }
  }
  return summary;
}

export async function pendingProximitySummaries(userId: string) {
  return prisma.proximity_sessions.findMany({ where: { userId, summaryReadyAt: { not: null }, summaryViewedAt: null },
    orderBy: { summaryReadyAt: 'desc' }, take: 10, select: { id: true, summaryCount: true, summaryReadyAt: true } });
}

export async function markProximitySummaryViewed(userId: string, sessionId: string) {
  const result = await prisma.proximity_sessions.updateMany({ where: { id: sessionId, userId }, data: { summaryViewedAt: new Date(), summaryStatus: 'viewed' } });
  if (result.count > 0) proximitySummaryCounter.inc({ outcome: 'viewed' });
  return result;
}
