import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { uploadMiddleware } from '../controllers/upload.controller';
import {
  createGroup,
  getGroup,
  getMyGroups,
  discoverGroups,
  getUserPendingInvites,
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

// Static routes first
router.get('/my', authenticate, getMyGroups);
router.get('/discover', optionalAuth, discoverGroups);
router.get('/invites/pending', authenticate, getUserPendingInvites);
router.get('/categories', getCategories);

// Create group
router.post('/', authenticate, createGroup);

// List/search groups
router.get('/', optionalAuth, listGroups);

// Dynamic routes
router.get('/:identifier', optionalAuth, getGroup);
router.put('/:groupId', authenticate, updateGroup);
router.post('/:groupId/upload/icon', authenticate, uploadMiddleware, uploadGroupIcon);
router.post('/:groupId/upload/cover', authenticate, uploadMiddleware, uploadGroupCover);
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
