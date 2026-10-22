/** Stable import surface; implementations are grouped by responsibility. */
export { addSkill, updateSkill, deleteSkill, searchSkills } from './professional-fields/skills.controller';
export {
  createExperience,
  updateExperience,
  deleteExperience,
  getUserExperiences,
} from './professional-fields/experience.controller';
export {
  createEducation,
  updateEducation,
  deleteEducation,
  getUserEducation,
} from './professional-fields/education.controller';
export {
  createProject,
  updateProject,
  deleteProject,
  featureProject,
  getUserProjects,
} from './professional-fields/projects.controller';
export {
  createCertificate,
  updateCertificate,
  deleteCertificate,
  getUserCertificates,
} from './professional-fields/certificates.controller';
export {
  createAchievement,
  updateAchievement,
  deleteAchievement,
  getUserAchievements,
} from './professional-fields/achievements.controller';
export { getInterests, addInterest, updateInterest, deleteInterest } from './professional-fields/interests.controller';
