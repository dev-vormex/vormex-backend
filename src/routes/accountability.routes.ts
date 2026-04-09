import { Router, RequestHandler } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getPartners, checkIn, getMentorships } from '../controllers/accountability.controller';

const router = Router();

router.use(authenticate);

router.get('/partners', getPartners as RequestHandler);
router.post('/partners/:pairId/check-in', checkIn as RequestHandler);
router.get('/mentorships', getMentorships as RequestHandler);

export default router;
