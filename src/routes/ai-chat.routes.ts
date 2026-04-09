import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { createAIRateLimitMiddleware } from '../middleware/ai-rate-limit.middleware';
import {
  getConversationStarters,
  getRevivalSuggestions,
  fixGrammar,
  getSmartReplies,
  changeTone,
  translateMessage,
  expandMessage,
  careerChat,
} from '../controllers/ai-chat.controller';

const router = Router();
const helperRateLimit = createAIRateLimitMiddleware('helper');
const careerRateLimit = createAIRateLimitMiddleware('career-chat');

router.use(authenticate);

router.post('/conversation-starters', helperRateLimit, getConversationStarters);
router.post('/revival-suggestions', helperRateLimit, getRevivalSuggestions);
router.post('/fix-grammar', helperRateLimit, fixGrammar);
router.post('/smart-replies', helperRateLimit, getSmartReplies);
router.post('/change-tone', helperRateLimit, changeTone);
router.post('/translate', helperRateLimit, translateMessage);
router.post('/expand', helperRateLimit, expandMessage);
router.post('/career-chat', careerRateLimit, careerChat);

export default router;
