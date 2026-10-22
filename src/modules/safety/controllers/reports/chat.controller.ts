import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { createUserBlockWithDeviceScope, recordSafetyEvent, invalidateBlockedUserIdsCache } from "../../services/trust-safety.service";
import { AuthRequest, wantsBlockAfterReport, emitSafetyStateChanged, createReportWithSafety, normalizeReason, truncateText, handleReportError } from "./support.controller";

export const reportChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const conversationId = String(req.params.conversationId ?? '');
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    const { reason, description, messageIds, blockUser } = req.body;

    const conv = await prisma.conversations.findUnique({ where: { id: conversationId } });
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (conv.participant1Id !== userId && conv.participant2Id !== userId) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    const reportedUserId =
      conv.participant1Id === userId ? conv.participant2Id : conv.participant1Id;

    const existingOpenReport = await prisma.moderation_reports.findFirst({
      where: {
        reporterId: userId,
        reportType: 'CHAT',
        conversationId,
        status: { in: ['PENDING', 'UNDER_REVIEW'] },
      },
      select: {
        id: true,
        status: true,
        blockedUserAfterReport: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingOpenReport) {
      let blockedUserAfterReport = existingOpenReport.blockedUserAfterReport;
      if (wantsBlockAfterReport(blockUser) && !blockedUserAfterReport) {
        const blockEffects = await prisma.$transaction(async (tx) => {
          const effects = await createUserBlockWithDeviceScope({
            blockerId: userId,
            blockedId: reportedUserId,
            reason: `Report ${existingOpenReport.id}`,
            tx,
          });
          const { block, deviceScopeCount } = effects;
          await tx.moderation_reports.update({
            where: { id: existingOpenReport.id },
            data: { blockedUserAfterReport: true },
          });
          await recordSafetyEvent({
            actorId: userId,
            targetUserId: reportedUserId,
            eventType: 'USER_BLOCKED',
            entityType: 'user_block',
            entityId: block.id,
            reason: 'Report and block',
            metadata: { deviceScopeCount },
            tx,
          });
          return effects;
        });
        await invalidateBlockedUserIdsCache(userId, ...blockEffects.affectedUserIds);
        emitSafetyStateChanged([userId, ...blockEffects.affectedUserIds]);
        blockedUserAfterReport = true;
      }

      res.json({
        success: true,
        message: 'You already submitted a report for this conversation. It is under review.',
        reportId: existingOpenReport.id,
        alreadyReported: true,
        status: existingOpenReport.status,
        blockedUserAfterReport,
      });
      return;
    }

    const reportMessageIds = Array.isArray(messageIds)
      ? messageIds.map(String).filter(Boolean).slice(0, 50)
      : [];
    if (reportMessageIds.length > 0) {
      const matchingMessages = await prisma.messages.count({
        where: { id: { in: reportMessageIds }, conversationId },
      });
      if (matchingMessages !== new Set(reportMessageIds).size) {
        res.status(400).json({ error: 'One or more messages do not belong to this conversation' });
        return;
      }
    }

    const messageExcerpts = reportMessageIds.length > 0
      ? await prisma.messages.findMany({
          where: { id: { in: reportMessageIds }, conversationId },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: {
            id: true,
            senderId: true,
            receiverId: true,
            content: true,
            contentType: true,
            mediaType: true,
            isDeleted: true,
            createdAt: true,
          },
        })
      : [];
    const extra = reportMessageIds.length > 0 ? { messageIds: reportMessageIds } : undefined;

    const row = await createReportWithSafety({
      reporterId: userId,
      reportedUserId,
      blockUser: wantsBlockAfterReport(blockUser),
      data: {
        reportType: 'CHAT',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        conversationId,
        reportedUserId,
        extra: extra ?? undefined,
        evidenceSnapshot: {
          conversation: {
            id: conversationId,
            participant1Id: conv.participant1Id,
            participant2Id: conv.participant2Id,
          },
          messages: messageExcerpts.map((message) => ({
            id: message.id,
            senderId: message.senderId,
            receiverId: message.receiverId,
            content: truncateText(message.content),
            contentType: message.contentType,
            mediaType: message.mediaType,
            isDeleted: message.isDeleted,
            createdAt: message.createdAt.toISOString(),
          })),
        },
      },
    });

    console.log('[reports] CHAT report saved', { id: row.id, conversationId, reporterId: userId });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    handleReportError(res, error, 'reportChat');
  }
};
