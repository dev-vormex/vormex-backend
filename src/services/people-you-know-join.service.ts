import { prisma } from '../config/prisma';
import { notificationService } from './notification.service';
import { pushNotificationService } from './push-notification.service';

const PEOPLE_YOU_KNOW_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PENDING_FLUSH_INTERVAL_MS = 60 * 1000;
const MATCH_STATUS_MATCHED = 'matched';
const MATCH_STATUS_UNMATCHED = 'unmatched';

let flushIntervalId: NodeJS.Timeout | null = null;
let isFlushInProgress = false;

function isCooldownExpired(lastNotifiedAt: Date | null | undefined, now: Date): boolean {
  if (!lastNotifiedAt) return true;
  return now.getTime() - lastNotifiedAt.getTime() >= PEOPLE_YOU_KNOW_COOLDOWN_MS;
}

async function sendJoinedContactNotification(userId: string, matchedUserIds: string[]): Promise<void> {
  const uniqueMatchedUserIds = Array.from(new Set(matchedUserIds.filter(Boolean)));
  if (uniqueMatchedUserIds.length === 0) {
    return;
  }

  const count = uniqueMatchedUserIds.length;
  const actorId = count === 1 ? uniqueMatchedUserIds[0] : undefined;

  await Promise.all([
    notificationService.notifyPeopleYouKnowJoined(userId, count, actorId),
    pushNotificationService.pushPeopleYouKnowJoined(userId, count),
  ]);
}

async function recalculateSyncCounts(tx: any, syncId: string, now: Date): Promise<void> {
  const entries = await tx.contactSyncEntry.findMany({
    where: { syncId },
    select: { matchStatus: true },
  });

  const totalCount = entries.length;
  const matchedCount = entries.filter((entry) => entry.matchStatus === MATCH_STATUS_MATCHED).length;
  const inviteCount = totalCount - matchedCount;

  await tx.contactSync.update({
    where: { id: syncId },
    data: {
      totalCount,
      matchedCount,
      inviteCount,
      lastSyncedAt: now,
      status: 'ready',
    },
  });
}

async function matchQueuedEntryAndMaybeNotify(
  entry: {
    id: string;
    syncId: string;
    sync: { userId: string };
  },
  matchedUserId: string
): Promise<void> {
  const now = new Date();

  const notificationPayload = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.contactSyncEntry.updateMany({
      where: {
        id: entry.id,
        matchStatus: MATCH_STATUS_UNMATCHED,
      },
      data: {
        matchStatus: MATCH_STATUS_MATCHED,
        matchedUserId,
      },
    });

    if (updateResult.count === 0) {
      return null;
    }

    await recalculateSyncCounts(tx, entry.syncId, now);

    const notificationWindow = await tx.contactJoinNotificationWindow.findUnique({
      where: { userId: entry.sync.userId },
      select: { lastNotifiedAt: true },
    });

    if (!isCooldownExpired(notificationWindow?.lastNotifiedAt, now)) {
      await tx.contactSyncEntry.update({
        where: { id: entry.id },
        data: {
          joinedNotificationQueuedAt: now,
        },
      });
      return null;
    }

    const pendingEntries = await tx.contactSyncEntry.findMany({
      where: {
        sync: { userId: entry.sync.userId },
        joinedNotificationQueuedAt: { not: null },
        joinedNotificationSentAt: null,
        matchedUserId: { not: null },
      },
      select: {
        id: true,
        matchedUserId: true,
      },
    });

    const idsToMarkSent = [entry.id, ...pendingEntries.map((pendingEntry) => pendingEntry.id)];
    const matchedUserIds = [
      matchedUserId,
      ...pendingEntries
        .map((pendingEntry) => pendingEntry.matchedUserId)
        .filter((value): value is string => Boolean(value)),
    ];

    await tx.contactSyncEntry.updateMany({
      where: { id: { in: idsToMarkSent } },
      data: {
        joinedNotificationQueuedAt: null,
        joinedNotificationSentAt: now,
      },
    });

    await tx.contactJoinNotificationWindow.upsert({
      where: { userId: entry.sync.userId },
      update: { lastNotifiedAt: now },
      create: {
        userId: entry.sync.userId,
        lastNotifiedAt: now,
      },
    });

    return {
      userId: entry.sync.userId,
      matchedUserIds,
    };
  });

  if (notificationPayload) {
    await sendJoinedContactNotification(
      notificationPayload.userId,
      notificationPayload.matchedUserIds
    );
  }
}

export async function processPeopleYouKnowJoinForUser(joinedUserId: string): Promise<void> {
  const joinedUser = await prisma.user.findUnique({
    where: { id: joinedUserId },
    select: {
      id: true,
      emailHash: true,
    },
  });

  if (!joinedUser?.emailHash) {
    return;
  }

  const candidateEntries = await prisma.contactSyncEntry.findMany({
    where: {
      emailHash: joinedUser.emailHash,
      matchStatus: MATCH_STATUS_UNMATCHED,
    },
    select: {
      id: true,
      syncId: true,
      sync: {
        select: {
          userId: true,
        },
      },
    },
  });

  for (const entry of candidateEntries) {
    await matchQueuedEntryAndMaybeNotify(entry, joinedUser.id);
  }
}

export async function flushPendingPeopleYouKnowNotifications(): Promise<void> {
  if (isFlushInProgress) {
    return;
  }

  isFlushInProgress = true;
  try {
    const now = new Date();
    const pendingEntries = await prisma.contactSyncEntry.findMany({
      where: {
        joinedNotificationQueuedAt: { not: null },
        joinedNotificationSentAt: null,
        matchedUserId: { not: null },
      },
      select: {
        id: true,
        matchedUserId: true,
        sync: {
          select: {
            userId: true,
          },
        },
      },
    });

    const entriesByUserId = new Map<
      string,
      Array<{ id: string; matchedUserId: string | null }>
    >();

    pendingEntries.forEach((entry) => {
      const key = entry.sync.userId;
      const bucket = entriesByUserId.get(key) ?? [];
      bucket.push({ id: entry.id, matchedUserId: entry.matchedUserId });
      entriesByUserId.set(key, bucket);
    });

    for (const [userId, entries] of entriesByUserId.entries()) {
      const window = await prisma.contactJoinNotificationWindow.findUnique({
        where: { userId },
        select: { lastNotifiedAt: true },
      });

      if (!isCooldownExpired(window?.lastNotifiedAt, now)) {
        continue;
      }

      const entryIds = entries.map((entry) => entry.id);
      const matchedUserIds = entries
        .map((entry) => entry.matchedUserId)
        .filter((value): value is string => Boolean(value));

      if (matchedUserIds.length === 0) {
        continue;
      }

      await prisma.$transaction([
        prisma.contactSyncEntry.updateMany({
          where: { id: { in: entryIds } },
          data: {
            joinedNotificationQueuedAt: null,
            joinedNotificationSentAt: now,
          },
        }),
        prisma.contactJoinNotificationWindow.upsert({
          where: { userId },
          update: { lastNotifiedAt: now },
          create: {
            userId,
            lastNotifiedAt: now,
          },
        }),
      ]);

      await sendJoinedContactNotification(userId, matchedUserIds);
    }
  } finally {
    isFlushInProgress = false;
  }
}

export function startPeopleYouKnowJoinScheduler(): void {
  if (flushIntervalId) {
    return;
  }

  flushIntervalId = setInterval(() => {
    flushPendingPeopleYouKnowNotifications().catch((error) => {
      console.error('[PeopleYouKnowJoinScheduler] Failed to flush pending notifications:', error);
    });
  }, PENDING_FLUSH_INTERVAL_MS);
}

export function stopPeopleYouKnowJoinScheduler(): void {
  if (!flushIntervalId) {
    return;
  }

  clearInterval(flushIntervalId);
  flushIntervalId = null;
}
