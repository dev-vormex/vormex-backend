import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { PeopleYouKnowResponse, buildPeopleYouKnowResponse } from "./support.controller";

export const getPeopleYouKnow = async (
  req: AuthenticatedRequest,
  res: Response<PeopleYouKnowResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const sync = await prisma.contactSync.findUnique({
      where: { userId: currentUserId },
      select: {
        id: true,
        lastSyncedAt: true,
        totalCount: true,
        matchedCount: true,
        inviteCount: true,
      },
    });

    if (!sync) {
      res.status(200).json({
        lastSyncedAt: null,
        matched: [],
        invites: [],
        stats: {
          totalContacts: 0,
          matchedCount: 0,
          inviteCount: 0,
        },
      });
      return;
    }

    const response = await buildPeopleYouKnowResponse(currentUserId, sync);
    res.status(200).json(response);
  } catch (error) {
    console.error('Error getting people you know:', error);
    res.status(500).json({ error: 'Failed to load people you know' });
  }
};
