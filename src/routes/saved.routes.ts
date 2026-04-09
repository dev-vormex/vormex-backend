import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getSaved,
  toggleSave,
  savePost,
  unsavePost,
  checkSaved,
} from '../controllers/saved.controller';

const router = Router();
router.use(authenticate);

router.get('/', getSaved);
router.get('/:postId/check', checkSaved);
router.post('/:postId/toggle', toggleSave);
router.post('/:postId', savePost);
router.delete('/:postId', unsavePost);

export default router;
