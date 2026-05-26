import { Router, RequestHandler } from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { requireAdmin } from '../middleware/admin.middleware';
import {
  applyToHackathonTeam,
  createHackathon,
  formHackathonTeam,
  getHackathon,
  getMyHackathonTeams,
  importExternalHackathonSources,
  listHackathonTeams,
  listHackathons,
  respondToHackathonTeamApplication,
  saveHackathon,
  unsaveHackathon,
} from '../controllers/hackathons.controller';

const router = Router();

router.get('/', optionalAuth, listHackathons as RequestHandler);
router.get('/me/teams', authenticate, getMyHackathonTeams as RequestHandler);
router.post('/', authenticate, createHackathon as RequestHandler);
router.post('/import/external', authenticate, requireAdmin as RequestHandler, importExternalHackathonSources as RequestHandler);
router.post('/teams/:teamId/apply', authenticate, applyToHackathonTeam as RequestHandler);
router.post('/team-applications/:applicationId/respond', authenticate, respondToHackathonTeamApplication as RequestHandler);
router.get('/:identifier', optionalAuth, getHackathon as RequestHandler);
router.get('/:hackathonId/teams', optionalAuth, listHackathonTeams as RequestHandler);
router.post('/:hackathonId/save', authenticate, saveHackathon as RequestHandler);
router.delete('/:hackathonId/save', authenticate, unsaveHackathon as RequestHandler);
router.post('/:hackathonId/teams/form', authenticate, formHackathonTeam as RequestHandler);

export default router;
