import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import {
  getConversations,
  getOrCreateConversation,
  getConversation,
  getMessages,
  sendMessage,
  markAsRead,
  deleteMessage,
  deleteConversation,
  editMessage,
  addReaction,
  getUnreadCount,
  searchMessages,
  getMessageLimitStatus,
  getMessageRequests,
  getMessageRequestsCount,
  acceptMessageRequest,
  declineMessageRequest,
} from '../controllers/chat.controller';
import { uploadChatMedia } from '../controllers/upload.controller';

const router = Router();

// Chat media upload middleware
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB limit
  },
});

router.use(authenticate);

router.get('/conversations', getConversations);
router.post('/conversations', getOrCreateConversation);
router.get('/conversations/:conversationId', getConversation);
router.get('/conversations/:conversationId/messages', getMessages);
router.post('/conversations/:conversationId/messages', sendMessage);
router.post('/conversations/:conversationId/read', markAsRead);
router.delete('/conversations/:conversationId', deleteConversation);
router.delete('/messages/:messageId', deleteMessage);
router.patch('/messages/:messageId', editMessage);
router.post('/messages/:messageId/reactions', addReaction);
router.get('/unread-count', getUnreadCount);
router.get('/search', searchMessages);
router.get('/message-limit/:userId', getMessageLimitStatus);
router.get('/requests', getMessageRequests);
router.get('/requests/count', getMessageRequestsCount);
router.post('/requests/:conversationId/accept', acceptMessageRequest);
router.delete('/requests/:conversationId', declineMessageRequest);
router.post('/upload', chatUpload.single('file'), uploadChatMedia);

export default router;
