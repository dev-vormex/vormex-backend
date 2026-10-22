import { ReengagementAdminPreviewResult } from "./parse-reengagement-hours.service";
import { previewReengagementForUser, loadUserSnapshotById, getCampaignDayContext } from "./preview-reengagement-for-user.service";
import { getCurrentReengagementWindow } from "./get-current-reengagement-window.service";
import { loadMeaningfulGrowthSnapshotMap } from "./build-reengagement-copy.service";
import { processUserForSlot } from "./run-reengagement-campaign.service";

export async function runReengagementForUser(
  userId: string,
  now: Date = new Date()
): Promise<ReengagementAdminPreviewResult> {
  const preview = await previewReengagementForUser(userId, now);
  if (!preview.eligible || !preview.slotDateKey || !preview.slotKey) {
    return preview;
  }

  const user = await loadUserSnapshotById(userId);
  const slot = getCurrentReengagementWindow(now).slot;
  if (!user || !slot) {
    return {
      ...preview,
      eligible: false,
      reason: user ? 'outside_slot_window' : 'user_not_found',
    };
  }

  const growthSnapshotByUser = await loadMeaningfulGrowthSnapshotMap(
    [userId],
    getCampaignDayContext(now, getCurrentReengagementWindow(now)).activityWindowStartUtc
  );

  const outcome = await processUserForSlot(
    user,
    slot,
    preview.slotDateKey,
    growthSnapshotByUser.get(userId)
  );

  const updatedPreview = await previewReengagementForUser(userId, now);
  return {
    ...updatedPreview,
    sendAttempted: true,
    sent: outcome === 'sent',
  };
}
