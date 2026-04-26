import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
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

const router = Router();

router.use(authenticate);

router.post('/verify', verifyAdmin);

router.use(requireAdmin);

// 2FA
router.post('/2fa/setup', setup2FA);
router.post('/2fa/verify', verify2FA);
router.post('/2fa/validate', validate2FA);

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

// Users
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.put('/users/:id', updateUser);
router.post('/users/:id/ban', banUser);
router.post('/users/:id/unban', unbanUser);
router.post('/users/:id/verify', verifyUser);
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
