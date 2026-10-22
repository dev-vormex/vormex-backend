import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { recordSafetyEvent } from "../../../safety/services/trust-safety.service";
import { invalidateAuthUserStatus } from "../../../auth/services/auth-user-status-cache.service";
import { revokeAllAuthSessions } from "../../../auth/services/auth-session.service";
import { invalidateUserProximity } from "../../../proximity/services/proximity-privacy.service";
import { AuthRequest, normalizeOptionalString } from "./support.controller";
import { parseSafetyDuration } from "./safety-restrictions.controller";
import { moderationReportInclude, mapModerationReportToAdminWithSafety } from "./reports.controller";

export const takeReportAction = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { id } = req.params;
    const { action, adminNotes, banReason, reason } = req.body ?? {};
    const normalizedAction = normalizeOptionalString(action) || 'NONE';
    const notes = normalizeOptionalString(adminNotes);
    const actionReason = normalizeOptionalString(reason) || normalizeOptionalString(banReason) || notes;

    const report = await prisma.moderation_reports.findUnique({ where: { id } });
    if (!report) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    if (
      !['MARK_UNDER_REVIEW', 'NONE'].includes(normalizedAction) &&
      !notes
    ) {
      res.status(400).json({ error: 'adminNotes is required for moderation actions' });
      return;
    }
    if (
      ['USER_WARNED', 'USER_RESTRICTED', 'USER_SUSPENDED', 'USER_BANNED'].includes(normalizedAction) &&
      !actionReason
    ) {
      res.status(400).json({ error: 'reason is required for user safety actions' });
      return;
    }

    let affectedUserId: string | null = null;
    let revokeSessions = false;
    const actionResults: Record<string, unknown> = {};
    await prisma.$transaction(async (tx) => {
      let nextStatus = 'RESOLVED';
      if (normalizedAction === 'MARK_UNDER_REVIEW') {
        nextStatus = 'UNDER_REVIEW';
      }
      if (['DISMISSED_INVALID', 'NO_VIOLATION', 'DISMISS'].includes(normalizedAction)) {
        nextStatus = 'DISMISSED';
      }

      if (normalizedAction === 'CONTENT_REMOVED') {
        if (report.reportedPostId) {
          await tx.post.update({
            where: { id: report.reportedPostId },
            data: { isActive: false },
          });
          actionResults.postRemoved = report.reportedPostId;
        }
        if (report.reportedCommentId) {
          await tx.post_comments.update({
            where: { id: report.reportedCommentId },
            data: { content: '[removed by moderation]' },
          });
          actionResults.commentRemoved = report.reportedCommentId;
        }
        const extra = report.extra && typeof report.extra === 'object' && !Array.isArray(report.extra) ? report.extra : {};
        const messageIds = Array.isArray(extra.messageIds) ? extra.messageIds : [];
        if (report.conversationId && messageIds.length) {
          await tx.messages.updateMany({
            where: {
              id: { in: messageIds.map(String) },
              conversationId: report.conversationId,
            },
            data: {
              content: '',
              isDeleted: true,
            },
          });
          actionResults.messagesRemoved = messageIds.length;
        }
      }

      if (report.reportedUserId && report.reportedUserId !== String(adminId)) {
        affectedUserId = report.reportedUserId;

        if (normalizedAction === 'USER_WARNED') {
          await recordSafetyEvent({
            actorId: String(adminId),
            targetUserId: report.reportedUserId,
            eventType: 'USER_WARNED',
            entityType: 'moderation_report',
            entityId: report.id,
            reason: actionReason,
            tx,
          });
          actionResults.warningRecorded = true;
        }

        if (normalizedAction === 'USER_RESTRICTED') {
          const restrictedUntil = parseSafetyDuration(req.body?.until || req.body?.days, 7 * 24 * 60 * 60 * 1000);
          await tx.user.update({
            where: { id: report.reportedUserId },
            data: {
              safetyRestrictedUntil: restrictedUntil,
              safetyRestrictionReason: actionReason,
            },
          });
          await recordSafetyEvent({
            actorId: String(adminId),
            targetUserId: report.reportedUserId,
            eventType: 'USER_RESTRICTED',
            entityType: 'moderation_report',
            entityId: report.id,
            reason: actionReason,
            metadata: { until: restrictedUntil.toISOString() },
            tx,
          });
          actionResults.restrictedUntil = restrictedUntil.toISOString();
        }

        if (normalizedAction === 'USER_SUSPENDED') {
          const suspendedUntil = parseSafetyDuration(req.body?.until || req.body?.days, 7 * 24 * 60 * 60 * 1000);
          await tx.user.update({
            where: { id: report.reportedUserId },
            data: { safetySuspendedUntil: suspendedUntil },
          });
          await recordSafetyEvent({
            actorId: String(adminId),
            targetUserId: report.reportedUserId,
            eventType: 'USER_SUSPENDED',
            entityType: 'moderation_report',
            entityId: report.id,
            reason: actionReason,
            metadata: { until: suspendedUntil.toISOString() },
            tx,
          });
          revokeSessions = true;
          actionResults.suspendedUntil = suspendedUntil.toISOString();
        }

        if (normalizedAction === 'USER_BANNED') {
          await tx.user.update({
            where: { id: report.reportedUserId },
            data: {
              isBanned: true,
              bannedReason: actionReason,
              safetyRestrictedUntil: null,
              safetySuspendedUntil: null,
            },
          });
          await recordSafetyEvent({
            actorId: String(adminId),
            targetUserId: report.reportedUserId,
            eventType: 'USER_BANNED',
            entityType: 'moderation_report',
            entityId: report.id,
            reason: actionReason,
            tx,
          });
          revokeSessions = true;
          actionResults.userBanned = report.reportedUserId;
        }
      }

      if (normalizedAction === 'CONTENT_REMOVED') {
        await recordSafetyEvent({
          actorId: String(adminId),
          targetUserId: report.reportedUserId || null,
          eventType: 'CONTENT_REMOVED',
          entityType: 'moderation_report',
          entityId: report.id,
          reason: notes,
          tx,
        });
      }
      await tx.moderation_reports.update({
        where: { id },
        data: {
          actionTaken: normalizedAction,
          adminNotes: notes || null,
          banReason: actionReason || null,
          status: nextStatus,
          reviewedById: String(adminId),
          reviewedAt: new Date(),
        },
      });
    });
    if (affectedUserId) {
      await invalidateAuthUserStatus(affectedUserId);
      if (revokeSessions) {
        await revokeAllAuthSessions(affectedUserId);
      }
      if (normalizedAction === 'USER_BANNED') {
        await invalidateUserProximity(affectedUserId, 'admin_ban');
      } else if (normalizedAction === 'USER_RESTRICTED') {
        await invalidateUserProximity(affectedUserId, 'safety_restricted');
      }
    }

    const updated = await prisma.moderation_reports.findUnique({
      where: { id },
      include: moderationReportInclude,
    });
    res.json({
      message: 'Action recorded',
      report: updated ? await mapModerationReportToAdminWithSafety(updated) : null,
      actionResults,
    });
  } catch (error) {
    console.error('takeReportAction error:', error);
    res.status(500).json({ error: 'Failed to take action' });
  }
};

// ============================================
// AUDIT LOGS (stub — no AuditLog model yet)
// ============================================

export const getAuditLogs = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      logs: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  } catch (error) {
    console.error('getAuditLogs error:', error);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
};
