import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { getFirebaseAuth } from '../services/firebase-admin.service';
import {
  createEvidenceStorageKey,
  storeEncryptedIdentityEvidence,
} from '../services/identity-evidence.service';
import {
  getIdentitySummary,
  hashSafetyValue,
  maskEmail,
  normalizePhoneE164,
  recordSafetyEvent,
  recomputeIdentityTrustLevel,
  safetyErrorResponse,
  setVerifiedPhone,
  trustLevelRank,
} from '../services/trust-safety.service';
import {
  generateEmailOtpCode,
  hashEmailOtp,
  normalizeEmailOtpCode,
  verifyEmailOtp,
} from '../utils/auth-security.util';
import { sendVerificationEmail } from '../utils/email.util';

const STUDENT_EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const STUDENT_EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;
const COMMON_PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

const ID_DOCUMENT_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function cleanEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function emailDomain(email: string): string | null {
  const [, domain] = email.split('@');
  return domain?.trim().toLowerCase() || null;
}

function looksLikeStudentDomain(domain: string): boolean {
  return (
    domain.endsWith('.edu') ||
    domain.endsWith('.edu.in') ||
    domain.endsWith('.ac.in') ||
    domain.includes('college') ||
    domain.includes('university') ||
    domain.includes('institute')
  );
}

async function validateStudentEmailDomain(params: {
  college?: string | null;
  studentEmail: string;
}): Promise<{ ok: boolean; error?: string; college: string | null; domain: string }> {
  const domain = emailDomain(params.studentEmail);
  if (!domain) {
    return { ok: false, error: 'Enter a valid student email address.', college: null, domain: '' };
  }
  if (COMMON_PERSONAL_EMAIL_DOMAINS.has(domain)) {
    return { ok: false, error: 'Use your college or student email address, not a personal email.', college: null, domain };
  }

  const college = String(params.college || '').trim();
  const community = college
    ? await prisma.college_communities.findFirst({
        where: { college: { equals: college, mode: 'insensitive' } },
        select: { college: true, emailDomains: true },
      })
    : null;
  if (community?.emailDomains?.length) {
    const allowed = community.emailDomains.some((item: string) => item.toLowerCase() === domain);
    if (!allowed) {
      return {
        ok: false,
        error: `Use an email domain approved for ${community.college}.`,
        college: community.college,
        domain,
      };
    }
    return { ok: true, college: community.college, domain };
  }

  if (!looksLikeStudentDomain(domain)) {
    return {
      ok: false,
      error: 'This does not look like a college or student email domain.',
      college: college || null,
      domain,
    };
  }

  return { ok: true, college: college || null, domain };
}

async function getLatestActiveIdDocumentVerification(userId: string) {
  return prisma.identity_verifications.findFirst({
    where: {
      userId,
      type: 'ID_DOCUMENT',
      status: { in: ['PENDING', 'VERIFIED'] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

function hasSubmittedEvidence(verification: any): boolean {
  return Boolean(
    verification?.evidenceStorageKey &&
    verification?.evidenceFileName &&
    !verification?.evidenceDeletedAt
  );
}

function buildIdUploadResponse(verification: { id: string; expiresAt?: Date | null }) {
  return {
    verificationId: verification.id,
    uploadMode: 'direct_submit',
    submitUrl: '/api/identity/id/submit',
    fieldName: 'evidence',
    maxBytes: 8 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    expiresAt: verification.expiresAt?.toISOString?.() || null,
  };
}

export const getMyIdentity = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const identity = await getIdentitySummary(userId);
    if (!identity) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ identity });
  } catch (error) {
    console.error('getMyIdentity error:', error);
    res.status(500).json({ error: 'Failed to load identity status' });
  }
};

export const verifyPhone = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const idToken = String(req.body?.idToken || '').trim();
    if (!idToken) {
      res.status(400).json({ error: 'Firebase ID token is required.' });
      return;
    }

    const firebaseAuth = getFirebaseAuth();
    if (!firebaseAuth) {
      res.status(503).json({
        error: 'Phone verification is not configured on the server.',
        code: 'firebase_phone_not_configured',
      });
      return;
    }

    const decoded = await firebaseAuth.verifyIdToken(idToken);
    const phoneNumber = normalizePhoneE164(String(decoded.phone_number || ''));
    if (!phoneNumber) {
      res.status(400).json({ error: 'Firebase token does not contain a verified phone number.' });
      return;
    }

    await setVerifiedPhone(userId, phoneNumber);
    const identity = await getIdentitySummary(userId);
    res.json({ message: 'Phone verified successfully.', identity });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('verifyPhone error:', error);
    res.status(500).json({ error: 'Failed to verify phone number' });
  }
};

export const requestStudentEmailVerification = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const studentEmail = cleanEmail(req.body?.studentEmail);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail)) {
      res.status(400).json({ error: 'Enter a valid student email address.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, college: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const domainCheck = await validateStudentEmailDomain({
      college: req.body?.college || user.college,
      studentEmail,
    });
    if (!domainCheck.ok) {
      res.status(400).json({ error: domainCheck.error, code: 'student_email_domain_invalid' });
      return;
    }

    const valueHash = hashSafetyValue(`student_email:${studentEmail}`);
    const now = new Date();
    const pending = await prisma.identity_verifications.findFirst({
      where: {
        userId,
        type: 'STUDENT_EMAIL',
        status: 'PENDING',
        valueHash,
        expiresAt: { gt: now },
      },
      orderBy: { requestedAt: 'desc' },
    });
    const lastRequestedAt = pending?.requestedAt || pending?.createdAt || null;
    if (lastRequestedAt) {
      const elapsedMs = now.getTime() - new Date(lastRequestedAt).getTime();
      if (elapsedMs < STUDENT_EMAIL_RESEND_COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil((STUDENT_EMAIL_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
          error: `Please wait ${retryAfterSeconds} seconds before requesting another code.`,
          code: 'student_email_resend_cooldown',
          retryAfterSeconds,
          expiresAt: pending.expiresAt ? pending.expiresAt.toISOString() : null,
          studentEmail: maskEmail(studentEmail),
        });
        return;
      }
    }

    await prisma.identity_verifications.updateMany({
      where: {
        userId,
        type: 'STUDENT_EMAIL',
        status: 'PENDING',
        valueHash,
      },
      data: { status: 'EXPIRED' },
    });

    const code = generateEmailOtpCode();
    const expiresAt = new Date(now.getTime() + STUDENT_EMAIL_OTP_TTL_MS);
    await prisma.identity_verifications.create({
      data: {
        userId,
        type: 'STUDENT_EMAIL',
        status: 'PENDING',
        valueHash,
        valueMasked: maskEmail(studentEmail),
        expiresAt,
        metadata: {
          otpHash: hashEmailOtp(studentEmail, code),
          studentEmail,
          college: domainCheck.college,
          domain: domainCheck.domain,
        },
      },
    });

    await sendVerificationEmail(studentEmail, code, user.name || 'there');
    await recordSafetyEvent({
      actorId: userId,
      targetUserId: userId,
      eventType: 'IDENTITY_STUDENT_EMAIL_REQUESTED',
      reason: domainCheck.domain,
    });

    res.json({
      message: 'Verification code sent to your student email.',
      expiresAt: expiresAt.toISOString(),
      studentEmail: maskEmail(studentEmail),
    });
  } catch (error) {
    console.error('requestStudentEmailVerification error:', error);
    res.status(500).json({ error: 'Failed to send student email verification code' });
  }
};

export const confirmStudentEmailVerification = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const studentEmail = cleanEmail(req.body?.studentEmail);
    const code = normalizeEmailOtpCode(String(req.body?.code || ''));
    if (!studentEmail || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Student email and a valid 6-digit code are required.' });
      return;
    }

    const valueHash = hashSafetyValue(`student_email:${studentEmail}`);
    const pending = await prisma.identity_verifications.findFirst({
      where: {
        userId,
        type: 'STUDENT_EMAIL',
        status: 'PENDING',
        valueHash,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    const metadata = (pending?.metadata || {}) as Record<string, unknown>;
    const otpHash = typeof metadata.otpHash === 'string' ? metadata.otpHash : null;
    if (!pending || !otpHash || !verifyEmailOtp(studentEmail, code, otpHash)) {
      res.status(400).json({ error: 'Invalid or expired verification code.' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.identity_verifications.update({
        where: { id: pending.id },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          metadata: {
            studentEmail,
            college: typeof metadata.college === 'string' ? metadata.college : null,
            domain: typeof metadata.domain === 'string' ? metadata.domain : emailDomain(studentEmail),
          },
        },
      });
      const college = typeof metadata.college === 'string' ? metadata.college : null;
      if (college) {
        await tx.college_student_verifications.upsert({
          where: { userId_college: { userId, college } },
          create: {
            userId,
            college,
            studentEmail,
            status: 'verified',
            method: 'student_email_otp',
            verifiedAt: new Date(),
          },
          update: {
            studentEmail,
            status: 'verified',
            method: 'student_email_otp',
            verifiedAt: new Date(),
          },
        });
      }
      await recomputeIdentityTrustLevel(userId, tx);
      await recordSafetyEvent({
        actorId: userId,
        targetUserId: userId,
        eventType: 'IDENTITY_STUDENT_EMAIL_VERIFIED',
        entityType: 'identity_verification',
        entityId: pending.id,
        tx,
      });
    });

    const identity = await getIdentitySummary(userId);
    res.json({ message: 'Student email verified successfully.', identity });
  } catch (error) {
    console.error('confirmStudentEmailVerification error:', error);
    res.status(500).json({ error: 'Failed to verify student email' });
  }
};

export const requestIdUpload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const active = await getLatestActiveIdDocumentVerification(userId);
    if (active?.status === 'VERIFIED') {
      res.status(409).json({
        error: 'Your student proof is already verified.',
        code: 'student_proof_already_verified',
      });
      return;
    }
    if (active?.status === 'PENDING') {
      if (hasSubmittedEvidence(active)) {
        res.status(409).json({
          error: 'Your student proof is already under review.',
          code: 'student_proof_under_review',
          verificationId: active.id,
        });
        return;
      }

      res.json(buildIdUploadResponse(active));
      return;
    }

    const storageKey = createEvidenceStorageKey(userId);
    const verification = await prisma.identity_verifications.create({
      data: {
        userId,
        type: 'ID_DOCUMENT',
        status: 'PENDING',
        evidenceStorageKey: storageKey,
        metadata: { uploadMode: 'direct_submit' },
        expiresAt: new Date(Date.now() + ID_DOCUMENT_REVIEW_WINDOW_MS),
      },
      select: { id: true, expiresAt: true },
    });

    res.json(buildIdUploadResponse(verification));
  } catch (error) {
    console.error('requestIdUpload error:', error);
    res.status(500).json({ error: 'Failed to prepare ID proof upload' });
  }
};

export const submitIdVerification = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'ID or student proof file is required.' });
      return;
    }

    const active = await getLatestActiveIdDocumentVerification(userId);
    if (active?.status === 'VERIFIED') {
      res.status(409).json({
        error: 'Your student proof is already verified.',
        code: 'student_proof_already_verified',
      });
      return;
    }
    if (active?.status === 'PENDING' && hasSubmittedEvidence(active)) {
      res.status(409).json({
        error: 'Your student proof is already under review.',
        code: 'student_proof_under_review',
        verificationId: active.id,
      });
      return;
    }

    const requestedId = String(req.body?.verificationId || '').trim();
    let verification = null;
    if (requestedId) {
      verification = await prisma.identity_verifications.findFirst({
          where: { id: requestedId, userId, type: 'ID_DOCUMENT', status: 'PENDING' },
        });
    }
    if (!verification && active?.status === 'PENDING') {
      verification = active;
    }
    if (!verification) {
      verification = await prisma.identity_verifications.create({
        data: {
          userId,
          type: 'ID_DOCUMENT',
          status: 'PENDING',
          evidenceStorageKey: createEvidenceStorageKey(userId),
          expiresAt: new Date(Date.now() + ID_DOCUMENT_REVIEW_WINDOW_MS),
        },
      });
    }

    const storageKey = verification.evidenceStorageKey || createEvidenceStorageKey(userId);
    await storeEncryptedIdentityEvidence({
      buffer: req.file.buffer,
      storageKey,
    });

    await prisma.identity_verifications.update({
      where: { id: verification.id },
      data: {
        evidenceStorageKey: storageKey,
        evidenceFileName: req.file.originalname,
        evidenceMimeType: req.file.mimetype,
        evidenceSize: req.file.size,
        evidenceDeletedAt: null,
        metadata: {
          uploadMode: 'encrypted_private_storage',
          submittedAt: new Date().toISOString(),
        },
      },
    });
    await recordSafetyEvent({
      actorId: userId,
      targetUserId: userId,
      eventType: 'IDENTITY_ID_SUBMITTED',
      entityType: 'identity_verification',
      entityId: verification.id,
    });

    const identity = await getIdentitySummary(userId);
    res.status(201).json({
      message: 'ID proof submitted for manual review.',
      verificationId: verification.id,
      status: 'PENDING',
      identity,
    });
  } catch (error) {
    console.error('submitIdVerification error:', error);
    res.status(500).json({ error: 'Failed to submit ID proof' });
  }
};

export const claimStudentBadge = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [user, verifiedStudentRecord] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, identityTrustLevel: true },
      }),
      prisma.identity_verifications.findFirst({
        where: {
          userId,
          status: 'VERIFIED',
          type: { in: ['STUDENT_EMAIL', 'ID_DOCUMENT'] },
        },
        select: { id: true },
      }),
    ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hasStudentTrust =
      trustLevelRank(user.identityTrustLevel) >= trustLevelRank('STUDENT_VERIFIED') ||
      Boolean(verifiedStudentRecord);
    if (!hasStudentTrust) {
      res.status(403).json({
        error: 'Complete student verification before claiming the student badge.',
        code: 'student_verification_required',
      });
      return;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { profileBadgeStyle: 'student' },
      select: { profileBadgeStyle: true },
    });

    await recordSafetyEvent({
      actorId: userId,
      targetUserId: userId,
      eventType: 'IDENTITY_STUDENT_BADGE_CLAIMED',
      entityType: 'user',
      entityId: userId,
      reason: 'Student verification badge claimed',
    });

    const identity = await getIdentitySummary(userId);
    res.json({
      message: 'Student badge added to your Vormex profile.',
      profileBadgeStyle: updatedUser.profileBadgeStyle,
      identity,
    });
  } catch (error) {
    console.error('claimStudentBadge error:', error);
    res.status(500).json({ error: 'Failed to claim student badge' });
  }
};
