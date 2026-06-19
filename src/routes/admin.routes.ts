import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { validateMultipartFields } from '../middleware/input-validation.middleware';
import {
  imageUploadRule,
  validateUploadedFiles,
  videoUploadRule,
} from '../middleware/upload-security.middleware';
import {
  verifyAdmin,
  setup2FA,
  verify2FA,
  validate2FA,
  getDashboardStats,
  getNotificationAudienceFilters,
  getReengagementNotificationStatus,
  getUsers,
  getUserById,
  updateUser,
  banUser,
  unbanUser,
  verifyUser,
  deleteUser,
  getPosts,
  deletePost,
  getReels,
  deleteReel,
  getGroups,
  deleteGroup,
  getAdminGroupMembers,
  updateAdminGroupMemberRole,
  removeAdminGroupMember,
  clearAdminGroupChat,
  getChatStorageSummary,
  clearAllChats,
  getIdentityReviews,
  getIdentityReviewById,
  getIdentityReviewEvidence,
  approveIdentityReview,
  rejectIdentityReview,
  warnUser,
  restrictUser,
  suspendUser,
  clearUserSafetyRestriction,
  getReports,
  getReportStats,
  getReportById,
  updateReportStatus,
  updateReportPriority,
  takeReportAction,
  getAuditLogs,
  runReengagementNotificationDryRun,
  sendAdminNotification,
} from '../controllers/admin.controller';
import {
  cancelPremiumAdminUser,
  getPremiumAdminEvents,
  getPremiumAdminOverview,
  getPremiumAdminUserDetail,
  getPremiumAdminUsers,
  sendPremiumAdminUserMessage,
  updatePremiumAdminSettings,
  updatePremiumAdminUser,
} from '../controllers/admin-premium.controller';
import {
  createManagedAd,
  deleteManagedAd,
  getManagedAdAnalytics,
  getManagedAdById,
  getManagedAds,
  updateManagedAd,
} from '../controllers/admin-managed-ads.controller';

const router = Router();
const managedAdUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 150 * 1024 * 1024,
    files: 3,
    parts: 30,
    fieldSize: 2 * 1024 * 1024,
  },
}).fields([
  { name: 'feedImage', maxCount: 1 },
  { name: 'reelsVideo', maxCount: 1 },
  { name: 'reelsThumbnail', maxCount: 1 },
]);
const validateManagedAdUpload = validateUploadedFiles({
  fields: {
    feedImage: imageUploadRule(10 * 1024 * 1024),
    reelsThumbnail: imageUploadRule(10 * 1024 * 1024),
    reelsVideo: videoUploadRule(150 * 1024 * 1024),
  },
  maxFiles: 3,
  requireKnownField: true,
});

const adminTwoFactorSetupRateLimit = createRateLimitMiddleware(() => [
  {
    keyPrefix: 'rate:user:admin:2fa-setup',
    limit: 3,
    windowSeconds: 60 * 60,
  },
]);

const adminTwoFactorVerifyRateLimit = createRateLimitMiddleware(() => [
  {
    keyPrefix: 'rate:ip:admin:2fa',
    limit: 10,
    windowSeconds: 15 * 60,
  },
  {
    keyPrefix: 'rate:user:admin:2fa',
    limit: 6,
    windowSeconds: 15 * 60,
  },
]);

router.use(authenticate);

router.get('/verify', verifyAdmin);
router.post('/verify', verifyAdmin);

// 2FA
router.post('/2fa/setup', adminTwoFactorSetupRateLimit, setup2FA);
router.post('/2fa/verify', adminTwoFactorVerifyRateLimit, verify2FA);
router.post('/2fa/validate', adminTwoFactorVerifyRateLimit, validate2FA);

router.use(requireAdmin);

// Dashboard
router.get('/dashboard/stats', getDashboardStats);

// Notifications
router.get('/notifications/filters', getNotificationAudienceFilters);
router.get('/notifications/reengagement/status', getReengagementNotificationStatus);
router.post('/notifications/reengagement/dry-run', runReengagementNotificationDryRun);
router.post('/notifications/send', sendAdminNotification);

// Premium
router.get('/premium/overview', getPremiumAdminOverview);
router.put('/premium/settings', updatePremiumAdminSettings);
router.get('/premium/users', getPremiumAdminUsers);
router.get('/premium/users/:id', getPremiumAdminUserDetail);
router.patch('/premium/users/:id', updatePremiumAdminUser);
router.post('/premium/users/:id/cancel', cancelPremiumAdminUser);
router.post('/premium/users/:id/message', sendPremiumAdminUserMessage);
router.get('/premium/events', getPremiumAdminEvents);

// Managed ads
router.get('/ads', getManagedAds);
router.post('/ads', managedAdUpload, validateManagedAdUpload, validateMultipartFields, createManagedAd);
router.get('/ads/:id/analytics', getManagedAdAnalytics);
router.get('/ads/:id', getManagedAdById);
router.patch('/ads/:id', managedAdUpload, validateManagedAdUpload, validateMultipartFields, updateManagedAd);
router.delete('/ads/:id', deleteManagedAd);

// Users
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.put('/users/:id', updateUser);
router.post('/users/:id/ban', banUser);
router.post('/users/:id/unban', unbanUser);
router.post('/users/:id/verify', verifyUser);
router.post('/users/:id/warn', warnUser);
router.post('/users/:id/restrict', restrictUser);
router.post('/users/:id/suspend', suspendUser);
router.post('/users/:id/clear-safety-restrictions', clearUserSafetyRestriction);
router.delete('/users/:id', deleteUser);

// Posts
router.get('/posts', getPosts);
router.delete('/posts/:id', deletePost);

// Reels
router.get('/reels', getReels);
router.delete('/reels/:id', deleteReel);

// Groups
router.get('/groups', getGroups);
router.delete('/groups/:id', deleteGroup);
router.get('/groups/:id/members', getAdminGroupMembers);
router.patch('/groups/:id/members/:userId', updateAdminGroupMemberRole);
router.delete('/groups/:id/members/:userId', removeAdminGroupMember);
router.post('/groups/:id/clear-chat', clearAdminGroupChat);

// Chat storage
router.get('/chats/storage', getChatStorageSummary);
router.post('/chats/clear', clearAllChats);

// Identity reviews
router.get('/identity-reviews', getIdentityReviews);
router.get('/identity-reviews/:id/evidence', getIdentityReviewEvidence);
router.get('/identity-reviews/:id', getIdentityReviewById);
router.post('/identity-reviews/:id/approve', approveIdentityReview);
router.post('/identity-reviews/:id/reject', rejectIdentityReview);

// Reports (stats before :id)
router.get('/reports/stats', getReportStats);
router.get('/reports', getReports);
router.get('/reports/:id', getReportById);
router.patch('/reports/:id/status', updateReportStatus);
router.patch('/reports/:id/priority', updateReportPriority);
router.post('/reports/:id/action', takeReportAction);

// Audit Logs
router.get('/audit-logs', getAuditLogs);

export default router;
