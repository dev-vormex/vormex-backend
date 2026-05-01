import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import * as audioController from '../controllers/audio.controller';

const router = Router();

// Discovery
router.get('/trending', optionalAuth, audioController.getTrendingAudio);
router.get('/search', optionalAuth, audioController.searchAudio);
router.get('/categories', audioController.getCategories);
router.get('/moods', audioController.getMoods);
router.get('/genre/:genre', optionalAuth, audioController.getAudioByGenre);

// Save audio
router.get('/saved', authenticate, audioController.getSavedAudio);
router.post('/:audioId/save', authenticate, audioController.toggleSaveAudio);

// Single audio
router.get('/:audioId', optionalAuth, audioController.getAudio);
router.get('/:audioId/reels', optionalAuth, audioController.getAudioReels);

export default router;
