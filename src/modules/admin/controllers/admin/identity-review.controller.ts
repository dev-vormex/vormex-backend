import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { readEncryptedIdentityEvidence, deleteIdentityEvidence } from "../../../identity/services/identity-evidence.service";
import { recomputeIdentityTrustLevel, recordSafetyEvent } from "../../../safety/services/trust-safety.service";
import { notificationService } from "../../../notifications/services/notification.service";
import { AuthRequest, normalizeOptionalString } from "./support.controller";

export // ============================================
// TRUST & SAFETY: IDENTITY REVIEWS
// ============================================

const identityReviewInclude = {
  user: {
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      profileImage: true,
      identityTrustLevel: true,
      phoneLast4: true,
      phoneVerifiedAt: true,
      isVerified: true,
    },
  },
  reviewerUser: {
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
    },
  },
};

export function mapIdentityReview(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    status: row.status,
    valueMasked: row.valueMasked,
    evidence: {
      hasFile: Boolean(row.evidenceStorageKey && !row.evidenceDeletedAt),
      fileName: row.evidenceFileName,
      mimeType: row.evidenceMimeType,
      size: row.evidenceSize,
      deletedAt: row.evidenceDeletedAt?.toISOString?.() || null,
    },
    reviewNotes: row.reviewNotes,
    rejectionReason: row.rejectionReason,
    requestedAt: row.requestedAt?.toISOString?.() || row.requestedAt,
    verifiedAt: row.verifiedAt?.toISOString?.() || null,
    expiresAt: row.expiresAt?.toISOString?.() || null,
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() || row.updatedAt,
    user: row.user
      ? {
          id: row.user.id,
          name: row.user.name,
          username: row.user.username,
          email: row.user.email,
          profileImage: row.user.profileImage,
          identityTrustLevel: row.user.identityTrustLevel,
          emailVerified: Boolean(row.user.isVerified),
          phoneMasked: row.user.phoneLast4 ? `•••• ${row.user.phoneLast4}` : null,
          phoneVerifiedAt: row.user.phoneVerifiedAt?.toISOString?.() || null,
        }
      : null,
    reviewer: (row.reviewerUser || row.reviewer)
      ? {
          id: (row.reviewerUser || row.reviewer).id,
          name: (row.reviewerUser || row.reviewer).name,
          username: (row.reviewerUser || row.reviewer).username,
          email: (row.reviewerUser || row.reviewer).email,
        }
      : null,
  };
}

export const getIdentityReviews = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const status = normalizeOptionalString(req.query.status) || 'PENDING';
    const type = normalizeOptionalString(req.query.type);

    const where: any = {};
    if (status !== 'all') where.status = status;
    if (type && type !== 'all') where.type = type;
    const pendingWhere: any = { status: 'PENDING' };
    if (type && type !== 'all') pendingWhere.type = type;

    const [rows, total, pendingCount] = await Promise.all([
      prisma.identity_verifications.findMany({
        where,
        include: identityReviewInclude,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      prisma.identity_verifications.count({ where }),
      prisma.identity_verifications.count({ where: pendingWhere }),
    ]);

    res.json({
      reviews: rows.map(mapIdentityReview),
      pendingCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error('getIdentityReviews error:', error);
    res.status(500).json({ error: 'Failed to load identity reviews' });
  }
};

export const getIdentityReviewById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const row = await prisma.identity_verifications.findUnique({
      where: { id },
      include: identityReviewInclude,
    });
    if (!row) {
      res.status(404).json({ error: 'Identity review not found' });
      return;
    }
    res.json({ review: mapIdentityReview(row) });
  } catch (error) {
    console.error('getIdentityReviewById error:', error);
    res.status(500).json({ error: 'Failed to load identity review' });
  }
};

export const getIdentityReviewEvidence = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const row = await prisma.identity_verifications.findUnique({
      where: { id },
      select: {
        evidenceStorageKey: true,
        evidenceFileName: true,
        evidenceMimeType: true,
        evidenceDeletedAt: true,
      },
    });
    if (!row || !row.evidenceStorageKey || row.evidenceDeletedAt) {
      res.status(404).json({ error: 'Identity evidence not found' });
      return;
    }

    const evidence = await readEncryptedIdentityEvidence(row.evidenceStorageKey);
    const fileName = String(row.evidenceFileName || 'student-proof').replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', row.evidenceMimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(evidence);
  } catch (error) {
    console.error('getIdentityReviewEvidence error:', error);
    res.status(500).json({ error: 'Failed to load identity evidence' });
  }
};

export const approveIdentityReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId ? String(req.user.userId) : null;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const reviewNotes = normalizeOptionalString(req.body?.reviewNotes) || 'Approved by Trust & Safety';

    const review = await prisma.identity_verifications.findUnique({ where: { id } });
    if (!review) {
      res.status(404).json({ error: 'Identity review not found' });
      return;
    }
    if (review.status !== 'PENDING') {
      res.status(409).json({ error: 'Identity review has already been decided' });
      return;
    }

    let evidenceDeletedAt: Date | null = null;
    if (review.evidenceStorageKey) {
      await deleteIdentityEvidence(review.evidenceStorageKey);
      evidenceDeletedAt = new Date();
    }

    let trustLevel = 'BASIC';
    await prisma.$transaction(async (tx) => {
      await tx.identity_verifications.update({
        where: { id },
        data: {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          reviewedById: adminId,
          reviewNotes,
          evidenceDeletedAt,
        },
      });
      trustLevel = await recomputeIdentityTrustLevel(review.userId, tx);
      await recordSafetyEvent({
        actorId: adminId,
        targetUserId: review.userId,
        eventType: 'IDENTITY_REVIEW_APPROVED',
        entityType: 'identity_verification',
        entityId: id,
        reason: reviewNotes,
        metadata: { type: review.type, evidenceDeleted: Boolean(evidenceDeletedAt) },
        tx,
      });
    });
    await notificationService.notifyIdentityVerificationApproved(review.userId, id, trustLevel);

    const updated = await prisma.identity_verifications.findUnique({
      where: { id },
      include: identityReviewInclude,
    });
    res.json({ message: 'Identity review approved', review: mapIdentityReview(updated) });
  } catch (error) {
    console.error('approveIdentityReview error:', error);
    res.status(500).json({ error: 'Failed to approve identity review' });
  }
};

export const rejectIdentityReview = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId ? String(req.user.userId) : null;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const rejectionReason = normalizeOptionalString(req.body?.rejectionReason);
    const reviewNotes = normalizeOptionalString(req.body?.reviewNotes) || rejectionReason;
    if (!rejectionReason) {
      res.status(400).json({ error: 'rejectionReason is required' });
      return;
    }

    const review = await prisma.identity_verifications.findUnique({ where: { id } });
    if (!review) {
      res.status(404).json({ error: 'Identity review not found' });
      return;
    }
    if (review.status !== 'PENDING') {
      res.status(409).json({ error: 'Identity review has already been decided' });
      return;
    }

    let evidenceDeletedAt: Date | null = null;
    if (review.evidenceStorageKey) {
      await deleteIdentityEvidence(review.evidenceStorageKey);
      evidenceDeletedAt = new Date();
    }

    await prisma.$transaction(async (tx) => {
      await tx.identity_verifications.update({
        where: { id },
        data: {
          status: 'REJECTED',
          reviewedById: adminId,
          reviewNotes,
          rejectionReason,
          evidenceDeletedAt,
        },
      });
      await recomputeIdentityTrustLevel(review.userId, tx);
      await recordSafetyEvent({
        actorId: adminId,
        targetUserId: review.userId,
        eventType: 'IDENTITY_REVIEW_REJECTED',
        entityType: 'identity_verification',
        entityId: id,
        reason: rejectionReason,
        metadata: { type: review.type, evidenceDeleted: Boolean(evidenceDeletedAt) },
        tx,
      });
    });
    await notificationService.notifyIdentityVerificationResubmitRequested(review.userId, id, rejectionReason);

    const updated = await prisma.identity_verifications.findUnique({
      where: { id },
      include: identityReviewInclude,
    });
    res.json({ message: 'Identity review rejected', review: mapIdentityReview(updated) });
  } catch (error) {
    console.error('rejectIdentityReview error:', error);
    res.status(500).json({ error: 'Failed to reject identity review' });
  }
};
