import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getNearbyUsers,
  updateLocation,
  updateLocationSettings,
  getCurrentLocation,
} from '../controllers/location.controller';

const router = Router();

router.use(authenticate);

router.get('/nearby', getNearbyUsers);
router.post('/update', updateLocation);
router.put('/settings', updateLocationSettings);
router.get('/current', getCurrentLocation);
router.get('/me', getCurrentLocation); // Alias for frontend compatibility

export default router;
