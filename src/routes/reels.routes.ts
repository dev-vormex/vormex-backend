import { Router } from 'express';
import multer from 'multer';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import * as reelsController from '../controllers/reels.controller';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB
});
const uploadWithThumbnail = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

// Feed endpoints
router.get('/feed', optionalAuth, reelsController.getReelsFeed);
router.get('/feed/following', authenticate, reelsController.getFollowingFeed);
router.get('/trending', optionalAuth, reelsController.getTrendingReels);

// Drafts (must be before :reelId)
router.get('/drafts', authenticate, reelsController.getDrafts);

// Single reel
router.get('/:reelId', optionalAuth, reelsController.getReel);
router.get('/:reelId/preload', optionalAuth, reelsController.getReelPreloadData);
router.get('/:reelId/audio', optionalAuth, reelsController.getReelAudio);

// Create/Edit/Delete
router.post('/', authenticate, uploadWithThumbnail, reelsController.createReel);
router.put('/:reelId', authenticate, reelsController.updateReel);
router.post('/:reelId/publish', authenticate, reelsController.publishDraft);
router.delete('/:reelId', authenticate, reelsController.deleteReel);

// Presigned upload URL (for direct-to-CDN upload)
router.post('/upload-url', authenticate, reelsController.getUploadUrl);
router.post('/upload-complete', authenticate, reelsController.onUploadComplete);

// Engagement
router.post('/:reelId/like', authenticate, reelsController.toggleLike);
router.post('/:reelId/save', authenticate, reelsController.toggleSave);
router.post('/:reelId/share', authenticate, reelsController.shareReel);
router.post('/:reelId/share/chat', authenticate, reelsController.shareReelInChat);
router.post('/:reelId/view', optionalAuth, reelsController.trackView);

// Comments
router.get('/:reelId/comments', optionalAuth, reelsController.getComments);
router.post('/:reelId/comments', authenticate, reelsController.createComment);
router.post('/:reelId/comments/:commentId/like', authenticate, reelsController.toggleCommentLike);
router.delete('/:reelId/comments/:commentId', authenticate, reelsController.deleteComment);
router.post('/:reelId/comments/:commentId/heart', authenticate, reelsController.heartComment);

// Interactive elements
router.post('/:reelId/poll/vote', authenticate, reelsController.votePoll);
router.post('/:reelId/quiz/answer', authenticate, reelsController.answerQuiz);

// Discovery
router.get('/hashtag/:hashtag', optionalAuth, reelsController.getReelsByHashtag);
router.get('/audio/:audioId', optionalAuth, reelsController.getReelsByAudio);
router.get('/user/:userId', optionalAuth, reelsController.getUserReels);
router.get('/user/:userId/liked', authenticate, reelsController.getUserLikedReels);
router.get('/user/:userId/saved', authenticate, reelsController.getUserSavedReels);

// Duets & Responses
router.get('/:reelId/responses', optionalAuth, reelsController.getReelResponses);

// Analytics
router.get('/analytics/creator', authenticate, reelsController.getCreatorAnalytics);
router.get('/analytics/reel/:reelId', authenticate, reelsController.getReelAnalytics);

// Reports
router.post('/:reelId/report', authenticate, reelsController.reportReel);

// Transcoding status (webhook from Bunny)
router.post('/webhook/transcoding', reelsController.transcodingWebhook);

export default router;
