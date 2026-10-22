import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { validateUrl, invalidateProfessionalProfileCaches } from "./support.controller";

// ============================================
// CERTIFICATES
// ============================================

/**
 * Create certificate
 * POST /api/users/me/certificates
 */
export const createCertificate = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { name, issuingOrg, issueDate, expiryDate, doesNotExpire, credentialId, credentialUrl } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > 100) {
      res.status(400).json({ error: 'name is required and must be 2-100 characters' });
      return;
    }

    if (!issuingOrg || typeof issuingOrg !== 'string' || issuingOrg.trim().length < 2 || issuingOrg.length > 100) {
      res.status(400).json({ error: 'issuingOrg is required and must be 2-100 characters' });
      return;
    }

    if (!issueDate) {
      res.status(400).json({ error: 'issueDate is required' });
      return;
    }

    if (credentialUrl && !validateUrl(credentialUrl)) {
      res.status(400).json({ error: 'credentialUrl must be a valid URL' });
      return;
    }

    if (expiryDate && !doesNotExpire && new Date(expiryDate) <= new Date(issueDate)) {
      res.status(400).json({ error: 'expiryDate must be after issueDate' });
      return;
    }

    const certificate = await prisma.certificate.create({
      data: {
        userId,
        name: name.trim(),
        issuingOrg: issuingOrg.trim(),
        issueDate: new Date(issueDate),
        expiryDate: expiryDate && !doesNotExpire ? new Date(expiryDate) : null,
        doesNotExpire: doesNotExpire || false,
        credentialId: credentialId?.trim() || null,
        credentialUrl: credentialUrl || null,
      },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(201).json(certificate);
  } catch (error) {
    console.error('Error creating certificate:', error);
    res.status(500).json({
      error: 'Failed to create certificate',
    });
  }
};

/**
 * Update certificate
 * PUT /api/users/me/certificates/:id
 */
export const updateCertificate = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const id = ensureString(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    // Verify ownership
    const certificate = await prisma.certificate.findUnique({
      where: { id },
    });

    if (!certificate || certificate.userId !== userId) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    const updateData: any = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length < 2 || req.body.name.length > 100) {
        res.status(400).json({ error: 'name must be 2-100 characters' });
        return;
      }
      updateData.name = req.body.name.trim();
    }

    if (req.body.issuingOrg !== undefined) {
      if (typeof req.body.issuingOrg !== 'string' || req.body.issuingOrg.trim().length < 2 || req.body.issuingOrg.length > 100) {
        res.status(400).json({ error: 'issuingOrg must be 2-100 characters' });
        return;
      }
      updateData.issuingOrg = req.body.issuingOrg.trim();
    }

    if (req.body.issueDate !== undefined) {
      updateData.issueDate = new Date(req.body.issueDate);
    }

    if (req.body.expiryDate !== undefined) {
      updateData.expiryDate = req.body.expiryDate ? new Date(req.body.expiryDate) : null;
    }

    if (req.body.doesNotExpire !== undefined) {
      updateData.doesNotExpire = req.body.doesNotExpire;
    }

    if (req.body.credentialId !== undefined) {
      updateData.credentialId = req.body.credentialId?.trim() || null;
    }

    if (req.body.credentialUrl !== undefined) {
      if (req.body.credentialUrl && !validateUrl(req.body.credentialUrl)) {
        res.status(400).json({ error: 'credentialUrl must be a valid URL' });
        return;
      }
      updateData.credentialUrl = req.body.credentialUrl || null;
    }

    // Validate expiry date
    const issueDate = updateData.issueDate || certificate.issueDate;
    const expiryDate = updateData.expiryDate !== undefined ? updateData.expiryDate : certificate.expiryDate;
    const doesNotExpire = updateData.doesNotExpire !== undefined ? updateData.doesNotExpire : certificate.doesNotExpire;

    if (expiryDate && !doesNotExpire && expiryDate <= issueDate) {
      res.status(400).json({ error: 'expiryDate must be after issueDate' });
      return;
    }

    const updated = await prisma.certificate.update({
      where: { id },
      data: updateData,
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('Error updating certificate:', error);
    res.status(500).json({
      error: 'Failed to update certificate',
    });
  }
};

/**
 * Delete certificate
 * DELETE /api/users/me/certificates/:id
 */
export const deleteCertificate = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>,
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const id = ensureString(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    // Verify ownership
    const certificate = await prisma.certificate.findUnique({
      where: { id },
    });

    if (!certificate || certificate.userId !== userId) {
      res.status(404).json({ error: 'Certificate not found' });
      return;
    }

    await prisma.certificate.delete({
      where: { id },
    });

    await invalidateProfessionalProfileCaches(userId);
    res.status(200).json({ message: 'Certificate deleted successfully' });
  } catch (error) {
    console.error('Error deleting certificate:', error);
    res.status(500).json({
      error: 'Failed to delete certificate',
    });
  }
};

/**
 * Get user certificates
 * GET /api/users/:userId/certificates
 */
export const getUserCertificates = async (
  req: AuthenticatedRequest,
  res: Response<any[] | ErrorResponse>,
): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const certificates = await prisma.certificate.findMany({
      where: { userId },
      orderBy: { issueDate: 'desc' },
    });

    // Sort: valid (not expired) first, then by issueDate DESC
    const now = new Date();
    const sorted = certificates.sort((a, b) => {
      const aValid = a.doesNotExpire || !a.expiryDate || new Date(a.expiryDate) > now;
      const bValid = b.doesNotExpire || !b.expiryDate || new Date(b.expiryDate) > now;

      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return b.issueDate.getTime() - a.issueDate.getTime();
    });

    res.status(200).json(sorted);
  } catch (error) {
    console.error('Error getting certificates:', error);
    res.status(500).json({
      error: 'Failed to fetch certificates',
    });
  }
};
