import { Router, RequestHandler } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { getSkillPassport } from '../controllers/skills.controller';

const router = Router();

router.get('/passport/:userId', optionalAuth, getSkillPassport as RequestHandler);
router.get('/passport', authenticate, getSkillPassport as RequestHandler);

export default router;
