import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getCompanies,
  getCompany,
  getJobs,
  getJob,
  getFeaturedJobs,
  getJobTypes,
  applyToJob,
  getMyApplications,
  saveJob,
  unsaveJob,
  getSavedJobs,
} from '../controllers/jobs.controller';

const router = Router();

// Public routes
router.get('/companies', getCompanies);
router.get('/companies/:slug', getCompany);
router.get('/', getJobs);
router.get('/featured', getFeaturedJobs);
router.get('/types', getJobTypes);
router.get('/:slug', getJob);

// Protected routes
router.use(authenticate);

router.post('/:jobId/apply', applyToJob);
router.get('/applications/me', getMyApplications);
router.post('/:jobId/save', saveJob);
router.delete('/:jobId/save', unsaveJob);
router.get('/saved', getSavedJobs);

export default router;
