import { Router } from 'express';
import multer from 'multer';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { validateMultipartFields } from '../middleware/input-validation.middleware';
import {
  imageUploadRule,
  validateUploadedFiles,
  videoUploadRule,
} from '../middleware/upload-security.middleware';
import * as reelsController from '../controllers/reels.controller';

const router = Router();
const uploadWithThumbnail = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 150 * 1024 * 1024,
    files: 2,
    parts: 20,
    fieldSize: 1 * 1024 * 1024,
  },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);
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
const validateReelUpload = validateUploadedFiles({
  fields: {
    thumbnail: imageUploadRule(10 * 1024 * 1024),
    video: videoUploadRule(150 * 1024 * 1024),
  },
  maxFiles: 2,
  requireKnownField: true,
});

// Feed endpoints
router.get('/feed', optionalAuth, reelsController.getReelsFeed);
router.get('/feed/following', authenticate, reelsController.getFollowingFeed);
router.get('/trending', optionalAuth, reelsController.getTrendingReels);

// Drafts (must be before :reelId)
router.get('/drafts', authenticate, reelsController.getDrafts);

// Presigned upload URL (for direct-to-CDN upload)
router.post('/upload-url', authenticate, mediaWriteLimit, reelsController.getUploadUrl);
router.post('/upload-complete', authenticate, mediaWriteLimit, reelsController.onUploadComplete);

// Discovery (must be before :reelId)
router.get('/hashtag/:hashtag', optionalAuth, reelsController.getReelsByHashtag);
router.get('/audio/:audioId', optionalAuth, reelsController.getReelsByAudio);
router.get('/user/:userId', optionalAuth, reelsController.getUserReels);
router.get('/user/:userId/liked', authenticate, reelsController.getUserLikedReels);
router.get('/user/:userId/saved', authenticate, reelsController.getUserSavedReels);

// Analytics (must be before :reelId)
router.get('/analytics/creator', authenticate, reelsController.getCreatorAnalytics);
router.get('/analytics/reel/:reelId', authenticate, reelsController.getReelAnalytics);

// Transcoding status (webhook from Bunny)
router.post('/webhook/transcoding', reelsController.transcodingWebhook);

// Create/Edit/Delete
router.post('/', authenticate, mediaWriteLimit, uploadWithThumbnail, validateReelUpload, validateMultipartFields, reelsController.createReel);
router.put('/:reelId', authenticate, reelsController.updateReel);
router.post('/:reelId/publish', authenticate, reelsController.publishDraft);
router.delete('/:reelId', authenticate, reelsController.deleteReel);

// Engagement
router.post('/:reelId/like', authenticate, reelsController.toggleLike);
router.post('/:reelId/save', authenticate, reelsController.toggleSave);
router.post('/:reelId/share', authenticate, reelsController.shareReel);
router.post('/:reelId/share/chat', authenticate, reelsController.shareReelInChat);
router.post('/:reelId/view', optionalAuth, reelsController.trackView);

// Single reel
router.get('/:reelId', optionalAuth, reelsController.getReel);
router.get('/:reelId/preload', optionalAuth, reelsController.getReelPreloadData);
router.get('/:reelId/audio', optionalAuth, reelsController.getReelAudio);

// Comments
router.get('/:reelId/comments', optionalAuth, reelsController.getComments);
router.post('/:reelId/comments', authenticate, reelsController.createComment);
router.post('/:reelId/comments/:commentId/like', authenticate, reelsController.toggleCommentLike);
router.delete('/:reelId/comments/:commentId', authenticate, reelsController.deleteComment);
router.post('/:reelId/comments/:commentId/heart', authenticate, reelsController.heartComment);

// Interactive elements
router.post('/:reelId/poll/vote', authenticate, reelsController.votePoll);
router.post('/:reelId/quiz/answer', authenticate, reelsController.answerQuiz);

// Duets & Responses
router.get('/:reelId/responses', optionalAuth, reelsController.getReelResponses);

// Reports
router.post('/:reelId/report', authenticate, reelsController.reportReel);

export default router;
