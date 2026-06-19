import { NextFunction, Request, Response, Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.middleware';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import { validateMultipartFields } from '../middleware/input-validation.middleware';
import { validateUploadedFiles } from '../middleware/upload-security.middleware';
import {
  confirmStudentEmailVerification,
  claimStudentBadge,
  getMyIdentity,
  requestIdUpload,
  requestStudentEmailVerification,
  submitIdVerification,
  verifyPhone,
} from '../controllers/identity.controller';

const router = Router();
const ID_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

const identityWriteLimit = createRateLimitMiddleware((req) => [
  {
    keyPrefix: 'rate:ip:identity',
    limit: 30,
    windowSeconds: 60 * 60,
  },
  ...(req.user?.userId
    ? [{
        keyPrefix: 'rate:user:identity',
        limit: 20,
        windowSeconds: 60 * 60,
      }]
    : []),
]);

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ID_EVIDENCE_MAX_BYTES,
    files: 1,
    parts: 8,
    fieldSize: 16 * 1024,
  },
});

const handleEvidenceUpload = (req: Request, res: Response, next: NextFunction): void => {
  evidenceUpload.single('evidence')(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'ID proof must be under 8 MB.' });
      return;
    }
    next(error);
  });
};

const validateEvidenceUpload = validateUploadedFiles({
  fields: {
    evidence: {
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      maxBytes: ID_EVIDENCE_MAX_BYTES,
    },
  },
  maxFiles: 1,
  requireKnownField: true,
});

router.use(authenticate);

router.get('/me', getMyIdentity);
router.post('/phone/verify', identityWriteLimit, verifyPhone);
router.post('/student-email/request', identityWriteLimit, requestStudentEmailVerification);
router.post('/student-email/confirm', identityWriteLimit, confirmStudentEmailVerification);
router.post('/student-badge/claim', identityWriteLimit, claimStudentBadge);
router.post('/id/request-upload', identityWriteLimit, requestIdUpload);
router.post(
  '/id/submit',
  identityWriteLimit,
  handleEvidenceUpload,
  validateEvidenceUpload,
  validateMultipartFields,
  submitIdVerification
);

export default router;
