import { Router, RequestHandler } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import {
  deleteSkillVerificationLink,
  endorseSkill,
  getSkillPassport,
  upsertSkillVerificationLink,
} from '../controllers/skills.controller';

const router = Router();

router.get('/passport/:userId', optionalAuth, getSkillPassport as RequestHandler);
router.get('/passport', authenticate, getSkillPassport as RequestHandler);
router.post('/:userId/endorse', authenticate, endorseSkill as RequestHandler);
router.post('/verification-links', authenticate, upsertSkillVerificationLink as RequestHandler);
router.delete('/verification-links/:provider', authenticate, deleteSkillVerificationLink as RequestHandler);

export default router;
