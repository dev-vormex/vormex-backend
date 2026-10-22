/** Stable import surface; implementations live in focused responsibility modules. */
export {
  ReengagementCopyInput,
  ReengagementGrowthSnapshot,
  ReengagementCopy,
  ReengagementRunResult,
  ReengagementAdminPreviewResult,
  parseReengagementHours,
  getConfiguredReengagementSlots,
  isReengagementEnabled,
} from './reengagement-notification/parse-reengagement-hours.service';
export {
  buildReengagementCopy,
  getMeaningfulGrowthCount,
  hasMeaningfulGrowth,
} from './reengagement-notification/build-reengagement-copy.service';
export { previewReengagementForUser } from './reengagement-notification/preview-reengagement-for-user.service';
export { runReengagementForUser } from './reengagement-notification/run-reengagement-for-user.service';
export { getCurrentReengagementWindow } from './reengagement-notification/get-current-reengagement-window.service';
export { runReengagementCampaign } from './reengagement-notification/run-reengagement-campaign.service';
