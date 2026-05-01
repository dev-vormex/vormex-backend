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

// Protected routes
router.get('/applications/me', authenticate, getMyApplications);
router.get('/saved', authenticate, getSavedJobs);

router.get('/:slug', getJob);

// Protected routes with dynamic IDs
router.use(authenticate);

router.post('/:jobId/apply', applyToJob);
router.post('/:jobId/save', saveJob);
router.delete('/:jobId/save', unsaveJob);

export default router;
