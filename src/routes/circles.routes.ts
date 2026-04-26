import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { updateCircle } from '../controllers/circles.controller';

const router = Router();

router.put('/:circleId', authenticate, updateCircle);

export default router;
