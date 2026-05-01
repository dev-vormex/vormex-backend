import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
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

// Upload profile picture (requires auth, expects pre-cropped 1:1 image)
router.post('/upload/avatar', authenticate, mediaWriteLimit, uploadMiddleware, uploadProfilePicture);

// Delete profile picture (requires auth)
router.delete('/upload/avatar', authenticate, deleteProfilePicture);

// Upload banner image (requires auth, expects pre-cropped 3:1 image)
router.post('/upload/banner', authenticate, mediaWriteLimit, uploadMiddleware, uploadBanner);

// Delete banner image (requires auth)
router.delete('/upload/banner', authenticate, deleteBanner);

// Upload certificate image
router.post('/upload/certificate', authenticate, mediaWriteLimit, uploadMiddleware, uploadCertificate);

// Upload project image
router.post('/upload/project', authenticate, mediaWriteLimit, uploadMiddleware, uploadProject);

// Upload logo image
router.post('/upload/logo', authenticate, mediaWriteLimit, uploadMiddleware, uploadLogo);

// Group image uploads (alternative path - groupId in form body)
router.post('/upload/group-icon', authenticate, mediaWriteLimit, uploadMiddleware, groupIdFromBody, uploadGroupIcon);
router.post('/upload/group-cover', authenticate, mediaWriteLimit, uploadMiddleware, groupIdFromBody, uploadGroupCover);

// Chat media upload compatibility path. Primary chat route is /api/chat/upload.
router.post('/upload/chat', authenticate, mediaWriteLimit, handleChatUpload, uploadChatMedia);

// Generic file delete
router.delete('/upload', authenticate, deleteFile);

export default router;
