import { Router } from 'express';
import { getAIEntitlements } from '../controllers/ai.controller';
import { authenticate } from '../../../shared/middleware/auth.middleware';

const router = Router();

router.use(authenticate);
router.get('/entitlements', getAIEntitlements);

export default router;
