import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getProfile,
  browsePeople,
  publicDiscoveryOpenApi,
  readMyVisibility,
  searchOpportunities,
  searchPeople,
  sitemapProfiles,
  writeMyVisibility,
} from '../controllers/public-discovery.controller';

const router = Router();
const safe = (handler: (req: any, res: any) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res)).catch(next);

router.get('/openapi.json', publicDiscoveryOpenApi);
router.get('/people', safe(browsePeople));
router.post('/people/search', safe(searchPeople));
router.get('/profiles/:username', safe(getProfile));
router.post('/opportunities/search', safe(searchOpportunities));
router.get('/sitemap/profiles', safe(sitemapProfiles));
router.get('/visibility/me', authenticate, safe(readMyVisibility));
router.patch('/visibility/me', authenticate, safe(writeMyVisibility));

export default router;
