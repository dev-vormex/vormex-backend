import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getMyProgress } from '../controllers/progress.controller';

const router = Router();

router.use(authenticate);

router.get('/me', getMyProgress);

export default router;
