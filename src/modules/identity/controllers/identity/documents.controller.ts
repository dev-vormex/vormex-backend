import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { createEvidenceStorageKey, storeEncryptedIdentityEvidence } from "../../services/identity-evidence.service";
import { prisma } from "../../../../config/prisma";
import { recordSafetyEvent, getIdentitySummary } from "../../../safety/services/trust-safety.service";
import { getLatestActiveIdDocumentVerification, hasSubmittedEvidence, buildIdUploadResponse, ID_DOCUMENT_REVIEW_WINDOW_MS } from "./support.controller";

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
