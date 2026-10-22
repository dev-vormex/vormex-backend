/** Stable import surface; implementations are grouped by responsibility. */
export { getMyIdentity, verifyPhone, claimStudentBadge } from './identity/overview.controller';
export { requestStudentEmailVerification, confirmStudentEmailVerification } from './identity/student.controller';
export { requestIdUpload, submitIdVerification } from './identity/documents.controller';
