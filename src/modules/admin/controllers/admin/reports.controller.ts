import { prisma } from "../../../../config/prisma";
import { Response } from "express";
import { AuthRequest, normalizeOptionalString } from "./support.controller";

export // ============================================
// REPORTS
// ============================================

const reportUserSelect = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  email: true,
  isBanned: true,
  bannedReason: true,
  identityTrustLevel: true,
  safetyRestrictedUntil: true,
  safetySuspendedUntil: true,
} as const;

export const moderationReportInclude = {
  reporter: { select: reportUserSelect },
  reportedUser: { select: reportUserSelect },
  reviewerUser: { select: reportUserSelect },
  conversation: {
    include: {
      users_conversations_participant1IdTousers: {
        select: { id: true, name: true, username: true, profileImage: true },
      },
      users_conversations_participant2IdTousers: {
        select: { id: true, name: true, username: true, profileImage: true },
      },
    },
  },
} as const;

export function mapUserToReportUser(u: any) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    profileImage: u.profileImage,
    email: u.email,
    isBanned: u.isBanned,
    bannedReason: u.bannedReason,
    identityTrustLevel: u.identityTrustLevel,
    safetyRestrictedUntil: u.safetyRestrictedUntil?.toISOString?.() || null,
    safetySuspendedUntil: u.safetySuspendedUntil?.toISOString?.() || null,
  };
}

export function mapModerationReportToAdmin(row: any) {
  return {
    id: row.id,
    reportType: row.reportType,
    reason: row.reason,
    description: row.description,
    status: row.status,
    priority: row.priority,
    actionTaken: row.actionTaken,
    adminNotes: row.adminNotes,
    banReason: row.banReason,
    evidenceSnapshot: row.evidenceSnapshot,
    reporterPriorReports: row.reporterPriorReports || 0,
    reportedUserPriorReports: row.reportedUserPriorReports || 0,
    blockedUserAfterReport: Boolean(row.blockedUserAfterReport),
    chatMessages: null,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reporter: mapUserToReportUser(row.reporter),
    reportedUser: mapUserToReportUser(row.reportedUser),
    post: null,
    comment: null,
    conversation: row.conversation
      ? {
          id: row.conversation.id,
          participant1: mapUserToReportUser(row.conversation.users_conversations_participant1IdTousers),
          participant2: mapUserToReportUser(row.conversation.users_conversations_participant2IdTousers),
        }
      : null,
    group: null,
    reviewedBy: mapUserToReportUser(row.reviewerUser),
  };
}

export async function getReportDeviceScopeSummary(row: any) {
  if (!row.blockedUserAfterReport || !row.reporterId || !row.reportedUserId) {
    return {
      deviceScopedBlock: false,
      deviceScopeCount: 0,
      deviceLinkedAccountCount: 0,
    };
  }

  const block = await prisma.user_blocks.findUnique({
    where: {
      blockerId_blockedId: {
        blockerId: row.reporterId,
        blockedId: row.reportedUserId,
      },
    },
    include: {
      deviceScopes: {
        select: { installHash: true },
      },
    },
  });
  const installHashes = Array.from(new Set(
    (block?.deviceScopes || [])
      .map((scope: any) => scope.installHash)
      .filter(Boolean)
  ));
  const linkedAccounts = installHashes.length > 0
    ? await prisma.user_devices.findMany({
        where: {
          installHash: { in: installHashes },
          userId: { not: row.reportedUserId },
        },
        select: { userId: true },
        distinct: ['userId'],
      })
    : [];

  return {
    deviceScopedBlock: installHashes.length > 0,
    deviceScopeCount: installHashes.length,
    deviceLinkedAccountCount: linkedAccounts.length,
  };
}

export async function mapModerationReportToAdminWithSafety(row: any) {
  return {
    ...mapModerationReportToAdmin(row),
    ...(await getReportDeviceScopeSummary(row)),
  };
}

export const getReports = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const skip = (page - 1) * limit;
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    const search = normalizeOptionalString(req.query.search);

    const where: any = {};
    if (status && status !== 'all') where.status = status;
    if (type && type !== 'all') where.reportType = type;
    if (search) {
      where.OR = [
        { reason: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { reporter: { name: { contains: search, mode: 'insensitive' } } },
        { reporter: { username: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total, statusAgg] = await Promise.all([
      prisma.moderation_reports.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: moderationReportInclude,
      }),
      prisma.moderation_reports.count({ where }),
      prisma.moderation_reports.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const statusCounts = { PENDING: 0, UNDER_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 };
    for (const s of statusAgg) {
      const key = s.status as keyof typeof statusCounts;
      if (key in statusCounts) statusCounts[key] = s._count._all;
    }

    res.json({
      reports: await Promise.all(rows.map(mapModerationReportToAdminWithSafety)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
      statusCounts,
    });
  } catch (error) {
    console.error('getReports error:', error);
    res.status(500).json({ error: 'Failed to load reports' });
  }
};

export const getReportStats = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [total, pending, underReview, resolved] = await Promise.all([
      prisma.moderation_reports.count(),
      prisma.moderation_reports.count({ where: { status: 'PENDING' } }),
      prisma.moderation_reports.count({ where: { status: 'UNDER_REVIEW' } }),
      prisma.moderation_reports.count({ where: { status: 'RESOLVED' } }),
    ]);
    res.json({ total, pending, underReview, resolved });
  } catch (error) {
    console.error('getReportStats error:', error);
    res.status(500).json({ error: 'Failed to load report stats' });
  }
};

export const getReportById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const row = await prisma.moderation_reports.findUnique({
      where: { id },
      include: moderationReportInclude,
    });
    if (!row) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    const previousReports = row.reportedUserId
      ? await prisma.moderation_reports.findMany({
          where: {
            reportedUserId: row.reportedUserId,
            id: { not: row.id },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            reportType: true,
            reason: true,
            status: true,
            actionTaken: true,
            createdAt: true,
          },
        })
      : [];
    res.json({
      report: await mapModerationReportToAdminWithSafety(row),
      previousReports: previousReports.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('getReportById error:', error);
    res.status(500).json({ error: 'Failed to load report' });
  }
};

export const updateReportStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status || typeof status !== 'string') {
      res.status(400).json({ error: 'status required' });
      return;
    }
    const updated = await prisma.moderation_reports.update({
      where: { id },
      data: { status },
      include: moderationReportInclude,
    });
    res.json({ message: 'Updated', report: await mapModerationReportToAdminWithSafety(updated) });
  } catch (error) {
    console.error('updateReportStatus error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
};

export const updateReportPriority = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const priority = parseInt(String(req.body?.priority), 10);
    if (Number.isNaN(priority)) {
      res.status(400).json({ error: 'priority required' });
      return;
    }
    const updated = await prisma.moderation_reports.update({
      where: { id },
      data: { priority },
      include: moderationReportInclude,
    });
    res.json({ message: 'Updated', report: await mapModerationReportToAdminWithSafety(updated) });
  } catch (error) {
    console.error('updateReportPriority error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
};
