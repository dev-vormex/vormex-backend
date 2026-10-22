import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { hashSafetyValue, maskEmail, recordSafetyEvent, recomputeIdentityTrustLevel, getIdentitySummary } from "../../../safety/services/trust-safety.service";
import { generateEmailOtpCode, hashEmailOtp, normalizeEmailOtpCode, verifyEmailOtp } from "../../../auth/utils/auth-security.util";
import { sendVerificationEmail } from "../../../../infrastructure/email/email.util";
import { cleanEmail, validateStudentEmailDomain, STUDENT_EMAIL_RESEND_COOLDOWN_MS, STUDENT_EMAIL_OTP_TTL_MS, emailDomain } from "./support.controller";

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
    if (pending && lastRequestedAt) {
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
