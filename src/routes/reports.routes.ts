import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getReportReasons,
  reportPost,
  reportComment,
  reportChat,
  reportUser,
  reportGroup,
  getMyReports,
} from '../controllers/reports.controller';

const router = Router();

// Public route for report reasons
router.get('/reasons', getReportReasons);

// Protected routes
router.use(authenticate);

router.post('/post/:postId', reportPost);
router.post('/comment/:commentId', reportComment);
router.post('/chat/:conversationId', reportChat);
router.post('/user/:userId', reportUser);
router.post('/group/:groupId', reportGroup);
router.get('/my-reports', getMyReports);

export default router;
