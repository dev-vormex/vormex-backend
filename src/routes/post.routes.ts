import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import {
  getFeed,
  getPost,
  createPost,
  updatePost,
  deletePost,
  toggleLike,
  votePoll,
  getComments,
  createComment,
  toggleCommentLike,
  deleteComment,
  getLikes,
  sharePost,
} from '../controllers/post.controller';

const router = Router();
const postUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB for video
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

// All post routes require authentication
router.use(authenticate);

// Feed
router.get('/feed', getFeed);

// CRUD
router.get('/:postId', getPost);
router.post('/', mediaWriteLimit, postUpload.any(), createPost);
router.put('/:postId', updatePost);
router.delete('/:postId', deletePost);

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
