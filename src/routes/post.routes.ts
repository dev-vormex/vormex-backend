import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { validateMultipartFields } from '../middleware/input-validation.middleware';
import {
  imageUploadRule,
  validateUploadedFiles,
  videoUploadRule,
} from '../middleware/upload-security.middleware';
import {
  getFeed,
  getPost,
  createPost,
  updatePost,
  deletePost,
  respondToPostCollabInvite,
  toggleLike,
  votePoll,
  getComments,
  createComment,
  toggleCommentLike,
  deleteComment,
  getLikes,
  sharePost,
  getPostUploadUrl,
  finalizePostUpload,
} from '../controllers/post.controller';

const router = Router();
const POST_MULTIPART_FALLBACK_MAX_BYTES =
  Number(process.env.POST_MULTIPART_FALLBACK_MAX_BYTES || 10 * 1024 * 1024);
const postUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: POST_MULTIPART_FALLBACK_MAX_BYTES,
    files: 10,
    parts: 30,
    fieldSize: 1 * 1024 * 1024,
  },
});
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
const validatePostUpload = validateUploadedFiles({
  fields: {
    articleCoverImage: imageUploadRule(10 * 1024 * 1024),
    image: imageUploadRule(10 * 1024 * 1024),
    images: imageUploadRule(10 * 1024 * 1024),
    media: {
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'],
      maxBytes: 100 * 1024 * 1024,
    },
    video: videoUploadRule(100 * 1024 * 1024),
  },
  maxFiles: 10,
  requireKnownField: true,
});

// All post routes require authentication
router.use(authenticate);

// Feed
router.get('/feed', getFeed);

// CRUD
router.post('/upload-url', mediaWriteLimit, getPostUploadUrl);
router.post('/finalize-upload', mediaWriteLimit, finalizePostUpload);
router.get('/:postId', getPost);
router.post('/', mediaWriteLimit, postUpload.any(), validatePostUpload, validateMultipartFields, createPost);
router.put('/:postId', updatePost);
router.delete('/:postId', deletePost);
router.post('/:postId/collaborators/respond', respondToPostCollabInvite);

// Engagement
router.post('/:postId/like', toggleLike);
router.get('/:postId/likes', getLikes);
router.post('/:postId/poll/vote', votePoll);
router.post('/:postId/share', sharePost);

// Comments
router.get('/:postId/comments', getComments);
router.post('/:postId/comments', createComment);
router.post('/:postId/comments/:commentId/like', toggleCommentLike);
router.delete('/:postId/comments/:commentId', deleteComment);

export default router;
