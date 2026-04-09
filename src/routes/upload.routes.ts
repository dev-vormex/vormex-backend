import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import {
  uploadMiddleware,
  uploadProfilePicture,
  uploadBanner,
  deleteProfilePicture,
  deleteBanner,
  uploadCertificate,
  uploadProject,
  uploadLogo,
  deleteFile,
  uploadChatMedia,
} from '../controllers/upload.controller';
import { uploadGroupIcon, uploadGroupCover } from '../controllers/groups.controller';

const router = express.Router();

// Middleware to pass groupId from body to params (for group upload routes)
const groupIdFromBody = (req: Request, res: Response, next: NextFunction) => {
  const groupId = req.body?.groupId;
  if (!groupId || typeof groupId !== 'string') {
    res.status(400).json({ error: 'Group ID is required' });
    return;
  }
  req.params = req.params || {};
  req.params.groupId = groupId;
  next();
};

// Chat media upload middleware (allows larger files)
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB limit for chat media
  },
});

// Upload profile picture (requires auth, expects pre-cropped 1:1 image)
router.post('/upload/avatar', authenticate, uploadMiddleware, uploadProfilePicture);

// Delete profile picture (requires auth)
router.delete('/upload/avatar', authenticate, deleteProfilePicture);

// Upload banner image (requires auth, expects pre-cropped 3:1 image)
router.post('/upload/banner', authenticate, uploadMiddleware, uploadBanner);

// Delete banner image (requires auth)
router.delete('/upload/banner', authenticate, deleteBanner);

// Upload certificate image
router.post('/upload/certificate', authenticate, uploadMiddleware, uploadCertificate);

// Upload project image
router.post('/upload/project', authenticate, uploadMiddleware, uploadProject);

// Upload logo image
router.post('/upload/logo', authenticate, uploadMiddleware, uploadLogo);

// Group image uploads (alternative path - groupId in form body)
router.post('/upload/group-icon', authenticate, uploadMiddleware, groupIdFromBody, uploadGroupIcon);
router.post('/upload/group-cover', authenticate, uploadMiddleware, groupIdFromBody, uploadGroupCover);

// Generic file delete
router.delete('/upload', authenticate, deleteFile);

export default router;

