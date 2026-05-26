import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { validateMultipartFields } from '../middleware/input-validation.middleware';
import { chatUploadRule, validateUploadedFiles } from '../middleware/upload-security.middleware';
import {
  getConversations,
  getOrCreateConversation,
  getConversationStatusWithUser,
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
const CHAT_VIDEO_MAX_BYTES = 150 * 1024 * 1024;
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
const validateChatUpload = validateUploadedFiles({
  fields: {
    file: chatUploadRule(CHAT_VIDEO_MAX_BYTES),
  },
  maxFiles: 1,
  requireKnownField: true,
});

// Chat media upload middleware
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CHAT_VIDEO_MAX_BYTES, // Videos are capped at 90 seconds client-side.
    files: 1,
    parts: 10,
    fieldSize: 256 * 1024,
  },
});

const handleChatUpload = (req: Request, res: Response, next: NextFunction): void => {
  chatUpload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'Videos must be 90 seconds or less and under 150 MB. Other files must be under 25 MB.',
      });
      return;
    }

    next(error);
  });
};

router.use(authenticate);

router.get('/conversations', getConversations);
router.post('/conversations', getOrCreateConversation);
router.get('/users/:userId/status', getConversationStatusWithUser);
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
router.post('/upload', mediaWriteLimit, handleChatUpload, validateChatUpload, validateMultipartFields, uploadChatMedia);

export default router;
