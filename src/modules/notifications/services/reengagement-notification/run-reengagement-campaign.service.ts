import { prisma } from "../../../../config/prisma";
import { pushNotificationService } from "../push-notification.service";
import { UserSnapshot, ConfiguredSlot, ReengagementGrowthSnapshot, getHighestTrackedStreak, ReengagementRunResult, isReengagementEnabled, parsePositiveInt, DEFAULT_LOOKBACK_DAYS } from "./parse-reengagement-hours.service";
import { hasMeaningfulGrowth, getMeaningfulGrowthCount, buildReengagementCopy, loadMeaningfulGrowthSnapshotMap } from "./build-reengagement-copy.service";
import { findBestMatchCandidate, getEligibleAudienceWhere } from "./preview-reengagement-for-user.service";
import { reserveDelivery, getCurrentReengagementWindow } from "./get-current-reengagement-window.service";

export async function processUserForSlot(
  user: UserSnapshot,
  slot: ConfiguredSlot,
  slotDateKey: string,
  growthSnapshot: ReengagementGrowthSnapshot | null | undefined
): Promise<'sent' | 'failed' | 'skipped'> {
  if (hasMeaningfulGrowth(growthSnapshot)) {
    return 'skipped';
  }

  const currentUser = {
    college: user.college,
    connectionsCount: user.userStats?.connectionsCount || 0,
    createdAt: user.createdAt,
    meaningfulGrowthCount: getMeaningfulGrowthCount(growthSnapshot),
    postsCount: user._count.posts || 0,
    totalActiveDays: user.userStats?.totalActiveDays || 0,
    user_onboarding: user.user_onboarding,
  };
  const candidate = await findBestMatchCandidate(user);
  const highestStreak = getHighestTrackedStreak(user);
  const copy = buildReengagementCopy({
    candidate,
    currentUser,
    highestStreak,
    slot,
  });

  const delivery = await reserveDelivery(user.id, slot, slotDateKey, copy);
  if (!delivery) {
    return 'skipped';
  }

  const payloadData: Record<string, string> = {
    campaignDate: slotDateKey,
    campaignKind: 'reengagement',
    campaignSlot: slot.key,
    campaignType: copy.campaignType,
    ...copy.data,
  };

  if (candidate?.id) {
    payloadData.matchUserId = candidate.id;
    payloadData.matchReason = candidate.reason;
  }

  const sent = await pushNotificationService.pushReengagementNudge(user.id, {
    body: copy.body,
    campaignType: copy.campaignType,
    data: payloadData,
    title: copy.title,
  });

  await prisma.reengagement_notification_deliveries.update({
    where: { id: delivery.id },
    data: sent
      ? {
          reason: null,
          sentAt: new Date(),
          status: 'sent',
        }
      : {
          reason: 'push_not_sent',
          status: 'failed',
        },
  });

  return sent ? 'sent' : 'failed';
}

export async function runReengagementCampaign(now: Date = new Date()): Promise<ReengagementRunResult> {
  const window = getCurrentReengagementWindow(now);

  if (!isReengagementEnabled() || !window.slot || !window.slotDateKey || !window.activityWindowStartUtc) {
    return {
      currentIstHour: window.currentIstHour,
      failed: 0,
      processed: 0,
      sent: 0,
      skipped: 0,
      slotKey: null,
    };
  }

  const lookbackDays = parsePositiveInt(process.env.REENGAGEMENT_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS);
  const lookbackBoundary = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: getEligibleAudienceWhere(lookbackBoundary) as any,
    select: {
      _count: {
        select: {
          posts: true,
        },
      },
      college: true,
      createdAt: true,
      engagement_streaks: {
        select: {
          connectionStreak: true,
          loginStreak: true,
          messagingStreak: true,
          postingStreak: true,
        },
      },
      id: true,
      isBanned: true,
      lastActiveAt: true,
      name: true,
      user_onboarding: {
        select: {
          primaryGoal: true,
        },
      },
      userStats: {
        select: {
          connectionsCount: true,
          currentStreak: true,
          totalActiveDays: true,
          xp: true,
        },
      },
    },
  });

  const growthSnapshotByUser = await loadMeaningfulGrowthSnapshotMap(
    users.map((user) => user.id),
    window.activityWindowStartUtc
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const batchSize = 8;
  for (let index = 0; index < users.length; index += batchSize) {
    const batch = users.slice(index, index + batchSize);
    const results = await Promise.allSettled(
      batch.map((user) =>
        processUserForSlot(
          user as UserSnapshot,
          window.slot as ConfiguredSlot,
          window.slotDateKey as string,
          growthSnapshotByUser.get(user.id)
        )
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value === 'sent') sent += 1;
        else if (result.value === 'failed') failed += 1;
        else skipped += 1;
        continue;
      }

      failed += 1;
      console.error('[ReengagementCampaign] Failed to process user slot:', result.reason);
    }
  }

  return {
    currentIstHour: window.currentIstHour,
    failed,
    processed: users.length,
    sent,
    skipped,
    slotKey: window.slot.key,
  };
}
