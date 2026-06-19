import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getBlocks, blockUser, unblockUser } from '../controllers/safety.controller';

const router = Router();

router.use(authenticate);

router.get('/blocks', getBlocks);
router.post('/blocks/:userId', blockUser);
router.delete('/blocks/:userId', unblockUser);

export default router;
