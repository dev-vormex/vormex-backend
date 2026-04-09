import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getSettings,
  updateSettings,
} from '../controllers/notifications.controller';

const router = Router();

router.use(authenticate);

router.get('/', getNotifications);
router.get('/unread-count', getUnreadCount);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.post('/read', markAsRead);
router.post('/read-all', markAllAsRead);
router.delete('/:notificationId', deleteNotification);

export default router;
