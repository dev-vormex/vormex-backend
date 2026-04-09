import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  followUser,
  unfollowUser,
  getFollowStatus,
  getFollowers,
  getFollowing,
  getMutualInfo,
  getFollowCounts,
} from '../controllers/follow.controller';

const router = Router();

router.use(authenticate);

router.post('/:userId', followUser);
router.delete('/:userId', unfollowUser);
router.get('/status/:userId', getFollowStatus);
router.get('/followers/:userId', getFollowers);
router.get('/following/:userId', getFollowing);
router.get('/mutual/:userId', getMutualInfo);
router.get('/counts/:userId', getFollowCounts);

export default router;
