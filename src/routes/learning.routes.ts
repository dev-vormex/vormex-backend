import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getLearningPaths,
  getLearningPath,
  getFeaturedPaths,
  getCategories,
  enrollInPath,
  getMyEnrollments,
  dropEnrollment,
  getLesson,
  completeLesson,
  submitQuiz,
  getQuizAttempts,
} from '../controllers/learning.controller';

const router = Router();

// Public routes
router.get('/paths', getLearningPaths);
router.get('/paths/:slug', getLearningPath);
router.get('/featured', getFeaturedPaths);
router.get('/categories', getCategories);

// Protected routes
router.use(authenticate);

router.post('/enroll', enrollInPath);
router.get('/my-enrollments', getMyEnrollments);
router.delete('/enroll/:pathId', dropEnrollment);
router.get('/lessons/:lessonId', getLesson);
router.post('/lessons/:lessonId/complete', completeLesson);
router.post('/quiz/submit', submitQuiz);
router.get('/quiz/:quizId/attempts', getQuizAttempts);

export default router;
