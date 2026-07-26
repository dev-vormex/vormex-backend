import { createHash } from 'node:crypto';
import { profileViewAnalyticsCounter } from '../infrastructure/metrics/registry';
import { queueNames } from '../infrastructure/queue/queue-names';
import { getQueue, isQueueingEnabled } from '../infrastructure/queue/queues';
import { logger } from '../lib/logger';

const PROFILE_VIEW_DEDUPE_WINDOW_MS = 5 * 60 * 1_000;

export interface ProfileViewAnalyticsPayload {
  kind: 'profile_view';
  viewerId: string;
  viewedId: string;
  source: string;
  occurredAt: string;
}

export function profileViewAnalyticsJobId(
  viewerId: string,
  viewedId: string,
  occurredAtMs = Date.now()
): string {
  const bucket = Math.floor(occurredAtMs / PROFILE_VIEW_DEDUPE_WINDOW_MS);
  const digest = createHash('sha256')
    .update(`${viewerId}|${viewedId}|${bucket}`)
    .digest('hex')
    .slice(0, 32);
  return `profile-view-${digest}`;
}

/**
 * Profile views are best-effort analytics. They must not borrow a Prisma
 * connection from the API process after every profile response.
 */
export async function enqueueProfileViewAnalytics(
  viewerId: string,
  viewedId: string,
  source = 'profile_open',
  occurredAtMs = Date.now()
): Promise<boolean> {
  const normalizedViewerId = viewerId.trim();
  const normalizedViewedId = viewedId.trim();
  if (
    !normalizedViewerId ||
    !normalizedViewedId ||
    normalizedViewerId === normalizedViewedId
  ) {
    profileViewAnalyticsCounter.inc({ outcome: 'ignored' });
    return false;
  }

  if (!isQueueingEnabled()) {
    profileViewAnalyticsCounter.inc({ outcome: 'queue_unavailable' });
    return false;
  }

  const payload: ProfileViewAnalyticsPayload = {
    kind: 'profile_view',
    viewerId: normalizedViewerId,
    viewedId: normalizedViewedId,
    source: source.trim().slice(0, 80) || 'profile_open',
    occurredAt: new Date(occurredAtMs).toISOString(),
  };

  try {
    await getQueue(queueNames.analyticsEvents).add('profile_view', payload, {
      jobId: profileViewAnalyticsJobId(
        normalizedViewerId,
        normalizedViewedId,
        occurredAtMs
      ),
    });
    profileViewAnalyticsCounter.inc({ outcome: 'enqueued' });
    return true;
  } catch (error) {
    profileViewAnalyticsCounter.inc({ outcome: 'enqueue_failed' });
    logger.warn({
      event: 'profile_view.analytics_enqueue_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
