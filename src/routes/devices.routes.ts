import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  registerDevice,
  unregisterDevice,
} from '../controllers/devices.controller';

const router = Router();

router.use(authenticate);

router.post('/register', registerDevice);
router.delete('/unregister', unregisterDevice);

export default router;
