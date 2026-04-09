import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getHooks } from '../controllers/daily-hooks.controller';

const router = Router();

router.use(authenticate);
router.get('/', getHooks);

export default router;
