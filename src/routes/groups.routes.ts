import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { uploadMiddleware } from '../controllers/upload.controller';
import { imageUploadRule, validateUploadedFiles } from '../middleware/upload-security.middleware';
import {
  createGroup,
  getGroup,
  getMyGroups,
  discoverGroups,
  getUserPendingInvites,
  getGroupInviteLinkPreview,
  joinGroupByInviteLink,
  getGroupInviteLink,
  updateGroupInviteLinkSettings,
  resetGroupInviteLink,
  createGroupInvite,
  respondToGroupInvite,
  getGroupJoinRequests,
  respondToGroupJoinRequest,
  joinGroup,
  leaveGroup,
  getGroupMembers,
  getCategories,
  getGroupPosts,
  createGroupPost,
  listGroups,
  updateGroup,
  deleteGroup,
  updateMemberRole,
  removeMember,
  getGroupMessages,
  sendGroupMessage,
  uploadGroupIcon,
  uploadGroupCover,
} from '../controllers/groups.controller';

const router = Router();
const mediaWriteLimit = createRateLimitMiddleware((req) => [
  {
    keyPrefix: 'rate:ip:media',
    limit: 60,
    windowSeconds: 10 * 60,
  },
  ...(req.user?.userId
    ? [{
        keyPrefix: 'rate:user:media',
        limit: 30,
        windowSeconds: 10 * 60,
      }]
    : []),
]);
const validateGroupImageUpload = validateUploadedFiles({
  defaultRule: imageUploadRule(10 * 1024 * 1024),
  maxFiles: 1,
});

// Static routes first
router.get('/my', authenticate, getMyGroups);
router.get('/discover', optionalAuth, discoverGroups);
router.get('/invites/pending', authenticate, getUserPendingInvites);
router.get('/invites/link/:code', optionalAuth, getGroupInviteLinkPreview);
router.post('/invites/link/:code/join', authenticate, joinGroupByInviteLink);
router.post('/invites/:inviteId/respond', authenticate, respondToGroupInvite);
router.get('/categories', getCategories);

// Create group
router.post('/', authenticate, createGroup);

// List/search groups
router.get('/', optionalAuth, listGroups);

// Dynamic routes
router.get('/:groupId/invite-link', authenticate, getGroupInviteLink);
router.patch('/:groupId/invite-link/settings', authenticate, updateGroupInviteLinkSettings);
router.post('/:groupId/invite-link/reset', authenticate, resetGroupInviteLink);
router.post('/:groupId/invites', authenticate, createGroupInvite);
router.get('/:groupId/join-requests', authenticate, getGroupJoinRequests);
router.post('/:groupId/join-requests/:requestId/respond', authenticate, respondToGroupJoinRequest);
router.get('/:identifier', optionalAuth, getGroup);
router.put('/:groupId', authenticate, updateGroup);
router.post('/:groupId/upload/icon', authenticate, mediaWriteLimit, uploadMiddleware, validateGroupImageUpload, uploadGroupIcon);
router.post('/:groupId/upload/cover', authenticate, mediaWriteLimit, uploadMiddleware, validateGroupImageUpload, uploadGroupCover);
router.delete('/:groupId', authenticate, deleteGroup);
router.post('/:groupId/join', authenticate, joinGroup);
router.post('/:groupId/leave', authenticate, leaveGroup);
router.get('/:groupId/members', optionalAuth, getGroupMembers);
router.put('/:groupId/members/:userId', authenticate, updateMemberRole);
router.delete('/:groupId/members/:userId', authenticate, removeMember);
router.get('/:groupId/posts', optionalAuth, getGroupPosts);
router.post('/:groupId/posts', authenticate, createGroupPost);
router.get('/:groupId/messages', authenticate, getGroupMessages);
router.post('/:groupId/messages', authenticate, sendGroupMessage);

export default router;
