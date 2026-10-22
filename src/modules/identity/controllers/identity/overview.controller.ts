import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getIdentitySummary, normalizePhoneE164, setVerifiedPhone, safetyErrorResponse, trustLevelRank, recordSafetyEvent } from "../../../safety/services/trust-safety.service";
import { getFirebaseAuth } from "../../../../infrastructure/firebase/firebase-admin.service";
import { prisma } from "../../../../config/prisma";

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
