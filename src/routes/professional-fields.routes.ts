import express from 'express';
import * as controller from '../controllers/professional-fields.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * Professional Profile Fields Routes
 * 
 * Skills, Experience, Education, Projects, Certificates, Achievements, Interests
 */

// Skills
router.post('/users/me/skills', authenticate, controller.addSkill);
router.put('/users/me/skills/:id', authenticate, controller.updateSkill);
router.delete('/users/me/skills/:id', authenticate, controller.deleteSkill);
router.get('/skills/search', controller.searchSkills); // Public

// Experience
router.post('/users/me/experiences', authenticate, controller.createExperience);
router.put('/users/me/experiences/:id', authenticate, controller.updateExperience);
router.delete('/users/me/experiences/:id', authenticate, controller.deleteExperience);
router.get('/users/:userId/experiences', controller.getUserExperiences); // Public

// Education
router.post('/users/me/education', authenticate, controller.createEducation);
router.put('/users/me/education/:id', authenticate, controller.updateEducation);
router.delete('/users/me/education/:id', authenticate, controller.deleteEducation);
router.get('/users/:userId/education', controller.getUserEducation); // Public

// Projects
router.post('/users/me/projects', authenticate, controller.createProject);
router.put('/users/me/projects/:id', authenticate, controller.updateProject);
router.delete('/users/me/projects/:id', authenticate, controller.deleteProject);
router.post('/users/me/projects/:id/feature', authenticate, controller.featureProject);
router.get('/users/:userId/projects', controller.getUserProjects); // Public

// Certificates
router.post('/users/me/certificates', authenticate, controller.createCertificate);
router.put('/users/me/certificates/:id', authenticate, controller.updateCertificate);
router.delete('/users/me/certificates/:id', authenticate, controller.deleteCertificate);
router.get('/users/:userId/certificates', controller.getUserCertificates); // Public

// Achievements
router.post('/users/me/achievements', authenticate, controller.createAchievement);
router.put('/users/me/achievements/:id', authenticate, controller.updateAchievement);
router.delete('/users/me/achievements/:id', authenticate, controller.deleteAchievement);
router.get('/users/:userId/achievements', controller.getUserAchievements); // Public

// Interests
router.get('/users/me/interests', authenticate, controller.getInterests);
router.post('/users/me/interests', authenticate, controller.addInterest);
router.put('/users/me/interests/:interest', authenticate, controller.updateInterest);
router.delete('/users/me/interests/:interest', authenticate, controller.deleteInterest);

export default router;

