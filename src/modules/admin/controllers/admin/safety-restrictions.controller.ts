import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { recordSafetyEvent } from "../../../safety/services/trust-safety.service";
import { invalidateAuthUserStatus } from "../../../auth/services/auth-user-status-cache.service";
import { invalidateUserProximity } from "../../../proximity/services/proximity-privacy.service";
import { revokeAllAuthSessions } from "../../../auth/services/auth-session.service";
import { parseOptionalDateInput, AuthRequest, normalizeOptionalString } from "./support.controller";

export // ============================================
// TRUST & SAFETY: USER ACTIONS
// ============================================

const parseSafetyDuration = (value: any, fallbackMs: number): Date => {
  const explicit = parseOptionalDateInput(value);
  if (explicit) return explicit;
  const days = Number(value);
  if (Number.isFinite(days) && days > 0) {
    return new Date(Date.now() + Math.min(days, 365) * 24 * 60 * 60 * 1000);
  }
  return new Date(Date.now() + fallbackMs);
};

export const warnUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId ? String(req.user.userId) : null;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const reason = normalizeOptionalString(req.body?.reason);
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await recordSafetyEvent({
      actorId: adminId,
      targetUserId: id,
      eventType: 'USER_WARNED',
      reason,
      metadata: { note: normalizeOptionalString(req.body?.note) || null },
    });

    res.json({ message: 'Warning recorded' });
  } catch (error) {
    console.error('warnUser error:', error);
    res.status(500).json({ error: 'Failed to warn user' });
  }
};

export const restrictUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId ? String(req.user.userId) : null;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const reason = normalizeOptionalString(req.body?.reason);
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    const restrictedUntil = parseSafetyDuration(req.body?.until || req.body?.days, 7 * 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id },
      data: {
        safetyRestrictedUntil: restrictedUntil,
        safetyRestrictionReason: reason,
      },
    });
    await recordSafetyEvent({
      actorId: adminId,
      targetUserId: id,
      eventType: 'USER_RESTRICTED',
      reason,
      metadata: { until: restrictedUntil.toISOString() },
    });
    await invalidateAuthUserStatus(id);
    await invalidateUserProximity(id, 'safety_restricted');
    res.json({ message: 'User restricted', restrictedUntil: restrictedUntil.toISOString() });
  } catch (error) {
    console.error('restrictUser error:', error);
    res.status(500).json({ error: 'Failed to restrict user' });
  }
};

export const suspendUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId ? String(req.user.userId) : null;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const reason = normalizeOptionalString(req.body?.reason);
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    if (id === adminId) {
      res.status(400).json({ error: 'Cannot suspend yourself' });
      return;
    }
    const suspendedUntil = parseSafetyDuration(req.body?.until || req.body?.days, 7 * 24 * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id },
      data: {
        safetySuspendedUntil: suspendedUntil,
      },
    });
    await recordSafetyEvent({
      actorId: adminId,
      targetUserId: id,
      eventType: 'USER_SUSPENDED',
      reason,
      metadata: { until: suspendedUntil.toISOString() },
    });
    await invalidateAuthUserStatus(id);
    await revokeAllAuthSessions(id);
    res.json({ message: 'User suspended', suspendedUntil: suspendedUntil.toISOString() });
  } catch (error) {
    console.error('suspendUser error:', error);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
};

export const clearUserSafetyRestriction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId ? String(req.user.userId) : null;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    await prisma.user.update({
      where: { id },
      data: {
        safetyRestrictedUntil: null,
        safetyRestrictionReason: null,
        safetySuspendedUntil: null,
      },
    });
    await recordSafetyEvent({
      actorId: adminId,
      targetUserId: id,
      eventType: 'USER_RESTRICTIONS_CLEARED',
      reason: normalizeOptionalString(req.body?.reason) || null,
    });
    await invalidateAuthUserStatus(id);
    res.json({ message: 'User safety restrictions cleared' });
  } catch (error) {
    console.error('clearUserSafetyRestriction error:', error);
    res.status(500).json({ error: 'Failed to clear user safety restriction' });
  }
};
