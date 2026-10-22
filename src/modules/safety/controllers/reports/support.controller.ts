
import { Response } from "express";
import { getIO } from "../../../../realtime/socket-registry";
import { safetyErrorResponse, enforceTrustTierLimit, createUserBlockWithDeviceScope, recordSafetyEvent, invalidateBlockedUserIdsCache } from "../../services/trust-safety.service";
import { prisma } from "../../../../config/prisma";

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export const REPORT_REASONS = [
  { id: 'spam', label: 'Spam', description: 'Unwanted commercial content or spam' },
  { id: 'harassment', label: 'Harassment', description: 'Bullying or harassment' },
  { id: 'hate_speech', label: 'Hate Speech', description: 'Hateful or discriminatory content' },
  { id: 'violence', label: 'Violence', description: 'Violent or graphic content' },
  { id: 'inappropriate', label: 'Inappropriate', description: 'Inappropriate or adult content' },
  { id: 'misinformation', label: 'Misinformation', description: 'False or misleading information' },
  { id: 'impersonation', label: 'Impersonation', description: 'Pretending to be someone else' },
  { id: 'other', label: 'Other', description: 'Other violation' },
];

export const normalizeReason = (raw: unknown): string => {
  if (typeof raw !== 'string' || !raw.trim()) return 'other';
  return raw.trim().slice(0, 500);
};

export const truncateText = (value: unknown, max = 1200): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
};

export const wantsBlockAfterReport = (raw: unknown): boolean => raw === true || raw === 'true';

export const emitSafetyStateChanged = (userIds: string[]): void => {
  const io = getIO();
  if (!io) return;
  const payload = { reason: 'interaction_policy_changed', occurredAt: new Date().toISOString() };
  Array.from(new Set(userIds.filter(Boolean))).forEach((userId) => {
    io.to(`user:${userId}`).emit('safety:state_changed', payload);
  });
};

export const handleReportError = (res: Response, error: unknown, label: string): void => {
  const safety = safetyErrorResponse(error);
  if (safety) {
    res.status(safety.statusCode).json(safety.body);
    return;
  }
  console.error(`${label} error:`, error);
  res.status(500).json({ error: 'Failed to submit report' });
};

export async function createReportWithSafety(params: {
  reporterId: string;
  reportedUserId?: string | null;
  blockUser?: boolean;
  data: Record<string, unknown>;
}) {
  await enforceTrustTierLimit(params.reporterId, 'report');

  const [reporterPriorReports, reportedUserPriorReports] = await Promise.all([
    prisma.moderation_reports.count({ where: { reporterId: params.reporterId } }),
    params.reportedUserId
      ? prisma.moderation_reports.count({ where: { reportedUserId: params.reportedUserId } })
      : Promise.resolve(0),
  ]);

  const result = await prisma.$transaction(async (tx) => {
    const canBlock = Boolean(
      params.blockUser &&
        params.reportedUserId &&
        params.reportedUserId !== params.reporterId
    );

    const row = await tx.moderation_reports.create({
      data: {
        ...params.data,
        reporterPriorReports,
        reportedUserPriorReports,
        blockedUserAfterReport: canBlock,
      } as any,
    });

    let blockEffects: Awaited<ReturnType<typeof createUserBlockWithDeviceScope>> | null = null;
    if (canBlock && params.reportedUserId) {
      blockEffects = await createUserBlockWithDeviceScope({
        blockerId: params.reporterId,
        blockedId: params.reportedUserId,
        reason: `Report ${row.id}`,
        tx,
      });
      const { block, deviceScopeCount } = blockEffects;
      await recordSafetyEvent({
        actorId: params.reporterId,
        targetUserId: params.reportedUserId,
        eventType: 'USER_BLOCKED',
        entityType: 'user_block',
        entityId: block.id,
        reason: 'Report and block',
        metadata: { deviceScopeCount },
        tx,
      });
    }

    await recordSafetyEvent({
      actorId: params.reporterId,
      targetUserId: params.reportedUserId || null,
      eventType: 'REPORT_CREATED',
      entityType: 'moderation_report',
      entityId: row.id,
      reason: String(params.data.reason || 'other'),
      metadata: {
        reportType: params.data.reportType,
        blockedUserAfterReport: canBlock,
      },
      tx,
    });

    return { row, blockEffects };
  });

  if (result.blockEffects) {
    await invalidateBlockedUserIdsCache(params.reporterId, ...result.blockEffects.affectedUserIds);
    emitSafetyStateChanged([params.reporterId, ...result.blockEffects.affectedUserIds]);
  }
  return result.row;
}
