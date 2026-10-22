import { Request, Response } from "express";
import { prisma } from "../../../../config/prisma";
import { REPORT_REASONS, AuthRequest } from "./support.controller";

export const getReportReasons = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ reasons: REPORT_REASONS });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report reasons' });
  }
};

export const getMyReports = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 10, 50);
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.moderation_reports.findMany({
        where: { reporterId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          reportType: true,
          reason: true,
          status: true,
          conversationId: true,
          reportedPostId: true,
          reportedCommentId: true,
          reportedUserId: true,
          reportedGroupId: true,
          blockedUserAfterReport: true,
          createdAt: true,
        },
      }),
      prisma.moderation_reports.count({ where: { reporterId: userId } }),
    ]);

    res.json({
      reports: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error('getMyReports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
};
