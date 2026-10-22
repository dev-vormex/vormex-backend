import { Router } from 'express';
import { authenticate } from '../../../shared/middleware/auth.middleware';
import { updateCircle } from '../controllers/circles.controller';
import * as content from '../controllers/circle-content.controller';

const router = Router();

router.get('/discover', authenticate, content.discover);
router.get('/my/all', authenticate, content.mine);
router.post('/', authenticate, content.create);
router.get('/:circleId/members', authenticate, content.members);
router.get('/:circleId/posts', authenticate, content.posts);
router.post('/:circleId/posts', authenticate, content.createPost);
router.post('/:circleId/join', authenticate, content.join);
router.post('/:circleId/leave', authenticate, content.leave);
router.get('/:slug', authenticate, content.detail);
router.put('/:circleId', authenticate, updateCircle);

export default router;
