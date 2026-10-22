/** Stable import surface; implementations are grouped by responsibility. */
export { verifyAdmin, setup2FA, verify2FA, validate2FA } from './admin/authentication.controller';
export {
  getDashboardStats,
  getNotificationAudienceFilters,
  sendAdminNotification,
  getReengagementNotificationStatus,
  runReengagementNotificationDryRun,
} from './admin/notifications.controller';
export { getUsers, getUserById } from './admin/user-read.controller';
export { updateUser, banUser, unbanUser, verifyUser, deleteUser } from './admin/user-management.controller';
export { getPosts, deletePost, getReels, deleteReel } from './admin/content.controller';
export {
  getGroups,
  deleteGroup,
  getAdminGroupMembers,
  updateAdminGroupMemberRole,
  removeAdminGroupMember,
} from './admin/groups.controller';
export { clearAdminGroupChat, getChatStorageSummary, clearAllChats } from './admin/chat-cleanup.controller';
export {
  getIdentityReviews,
  getIdentityReviewById,
  getIdentityReviewEvidence,
  approveIdentityReview,
  rejectIdentityReview,
} from './admin/identity-review.controller';
export {
  warnUser,
  restrictUser,
  suspendUser,
  clearUserSafetyRestriction,
} from './admin/safety-restrictions.controller';
export {
  getReports,
  getReportStats,
  getReportById,
  updateReportStatus,
  updateReportPriority,
} from './admin/reports.controller';
export { takeReportAction, getAuditLogs } from './admin/report-actions.controller';
