import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { Prisma } from "@prisma/client";
import { getPremiumPlan } from "../../../premium/services/premium-access.service";
import { getPremiumVisibilityByUserIds, applyPremiumVisibilityToUser } from "../../../premium/services/premium-visibility.service";
import { AuthRequest } from "./support.controller";

export const getPendingRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;
    const now = new Date();

    const [orderedRows, total] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c."id"
        FROM "connections" c
        LEFT JOIN "subscriptions" s
          ON s."userId" = c."requesterId"
          AND s."plan" = ${getPremiumPlan()}
          AND LOWER(s."status") IN ('active', 'captured', 'authorized')
          AND (s."cancelledAt" IS NULL OR s."cancelledAt" > ${now})
          AND (s."currentPeriodEnd" IS NULL OR s."currentPeriodEnd" > ${now})
        LEFT JOIN LATERAL (
          SELECT MAX(b."priority") AS "boostPriority"
          FROM "profile_boosts" b
          WHERE b."userId" = c."requesterId"
            AND b."status" = 'active'
            AND b."startsAt" <= ${now}
            AND b."endsAt" > ${now}
        ) boost ON TRUE
        WHERE c."addresseeId" = ${req.user.userId}
          AND c."status" = 'pending'
        ORDER BY
          COALESCE(boost."boostPriority", 0) DESC,
          CASE WHEN s."id" IS NULL THEN 0 ELSE 1 END DESC,
          c."createdAt" DESC
        OFFSET ${skip}
        LIMIT ${limit}
      `),
      prisma.connections.count({
        where: {
          addresseeId: req.user.userId,
          status: 'pending',
        },
      }),
    ]);

    const orderedIds = orderedRows.map((row) => row.id).filter(Boolean);
    const unorderedConnections = orderedIds.length > 0
      ? await prisma.connections.findMany({
          where: { id: { in: orderedIds } },
          include: {
            users_connections_requesterIdTousers: {
              select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
            },
          },
        })
      : [];
    const connectionsById = new Map(unorderedConnections.map((connection) => [connection.id, connection]));
    const connections = orderedIds
      .map((id) => connectionsById.get(id))
      .filter((connection): connection is NonNullable<typeof connection> => Boolean(connection));
    const visibilityByUser = await getPremiumVisibilityByUserIds(
      connections.map((connection) => connection.requesterId)
    );
    const formatted = connections.map((conn) => {
      const connWithRequester = conn as typeof conn & { users_connections_requesterIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      const user = applyPremiumVisibilityToUser(
        connWithRequester.users_connections_requesterIdTousers,
        visibilityByUser
      );
      return {
        id: conn.id,
        status: 'PENDING',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        priority: visibilityByUser.get(conn.requesterId)?.requestQueuePriority || 0,
        priorityLabel: user.profileBoostActive
          ? 'Boosted'
          : user.isPremium
            ? 'Premium'
            : null,
        user,
      };
    });

    res.status(200).json({
      connections: formatted,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + connections.length < total,
    });
  } catch (error) {
    console.error('getPendingRequests error:', error);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
};

export const getSentRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: {
          requesterId: req.user.userId,
          status: 'pending',
        },
        include: {
          users_connections_addresseeIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.connections.count({
        where: {
          requesterId: req.user.userId,
          status: 'pending',
        },
      }),
    ]);

    const formatted = connections.map((conn) => {
      const connWithAddressee = conn as typeof conn & { users_connections_addresseeIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      return {
        id: conn.id,
        status: 'PENDING',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        user: connWithAddressee.users_connections_addresseeIdTousers,
      };
    });

    res.status(200).json({
      connections: formatted,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + connections.length < total,
    });
  } catch (error) {
    console.error('getSentRequests error:', error);
    res.status(500).json({ error: 'Failed to get sent requests' });
  }
};
