import { Router } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  createEvent,
  getEvent,
  getMyEvents,
  getUpcomingEvents,
  listEvents,
  rsvpToEvent,
} from '../controllers/events.controller';

const router = Router();

router.get('/', optionalAuth, listEvents);
router.get('/upcoming', optionalAuth, getUpcomingEvents);
router.get('/my', authenticate, getMyEvents);
router.post('/', authenticate, createEvent);
router.get('/:eventId', optionalAuth, getEvent);
router.post('/:eventId/rsvp', authenticate, rsvpToEvent);

export default router;
