import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
import {
  getStoriesFeed,
  createStory,
  getStory,
  getMyStories,
  deleteStory,
  getUserStories,
  viewStory,
  getStoryViewers,
  reactToStory,
  removeStoryReaction,
  replyToStory,
  getStoryReplies,
  createHighlight,
  getUserHighlights,
  getHighlightStories,
  updateHighlight,
  deleteHighlight,
  addStoryToHighlight,
  removeStoryFromHighlight,
  archiveStory,
  getArchivedStories,
} from '../controllers/stories.controller';

const router = Router();

// All stories routes require authentication
router.use(authenticate);

// Feed
router.get('/feed', getStoriesFeed);

// My stories
router.get('/me', getMyStories);

// Archive
router.get('/archive', getArchivedStories);

// Highlights - user specific
router.get('/highlights/user/:userId', getUserHighlights);

// Highlights CRUD
router.post('/highlights', createHighlight);
router.get('/highlights/:highlightId', getHighlightStories);
router.patch('/highlights/:highlightId', updateHighlight);
router.delete('/highlights/:highlightId', deleteHighlight);
router.post('/highlights/:highlightId/stories/:storyId', addStoryToHighlight);
router.delete('/highlights/:highlightId/stories/:storyId', removeStoryFromHighlight);

// User stories
router.get('/user/:userId', getUserStories);

// Story CRUD (supports both JSON and multipart/form-data for media)
router.post('/', upload.single('media'), createStory);
router.get('/:storyId', getStory);
router.delete('/:storyId', deleteStory);

// Story interactions
router.post('/:storyId/view', viewStory);
router.get('/:storyId/viewers', getStoryViewers);
router.post('/:storyId/react', reactToStory);
router.delete('/:storyId/react', removeStoryReaction);
router.post('/:storyId/reply', replyToStory);
router.get('/:storyId/replies', getStoryReplies);
router.post('/:storyId/archive', archiveStory);

export default router;
