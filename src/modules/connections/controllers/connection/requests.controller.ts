import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { assertUsersCanInteract, enforceTrustTierLimit, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { getConnectionRequestLimitState, FREE_CONNECTION_REQUESTS_PER_DAY } from "../../../safety/services/tier-limits.service";
import { randomUUID } from "crypto";
import { notificationService } from "../../../notifications/services/notification.service";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { ensureString } from "../../../../shared/utils/request.util";
import { enqueueOutboxEvent } from "../../../../infrastructure/outbox/service";
import { queueNames } from "../../../../infrastructure/queue/queue-names";
import { AuthRequest, canonicalRelationship, invalidateDiscoveryCaches } from "./support.controller";

export const sendConnectionRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { receiverId, message } = req.body;

    if (!receiverId) {
      res.status(400).json({ error: 'Receiver ID is required' });
      return;
    }

    if (receiverId === req.user.userId) {
      res.status(400).json({ error: 'Cannot send connection request to yourself' });
      return;
    }

    /*
     * One round trip instead of four. These reads do not depend on each other:
     * the receiver record, the requester's display name (needed only for the
     * notifications below), any existing connection row, and the safety gate.
     * Running them in series was a large part of why the client sat on a
     * spinner for seconds per click.
     *
     * `assertUsersCanInteract` rejects for blocked/banned/suspended pairs; a
     * missing receiver is not something it throws on, so the 404 below still
     * takes precedence for that case.
     */
    const [receiver, requester, existingConnection] = await Promise.all([
      prisma.user.findUnique({
        where: { id: receiverId },
        select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
      }),
      prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { name: true },
      }),
      prisma.connections.findFirst({
        where: {
          OR: [
            { requesterId: req.user.userId, addresseeId: receiverId },
            { requesterId: receiverId, addresseeId: req.user.userId },
          ],
        },
      }),
      assertUsersCanInteract(req.user.userId, receiverId, 'connection request'),
    ]);

    if (!receiver) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (existingConnection) {
      if (existingConnection.status === 'accepted') {
        res.status(200).json({
          message: 'Already connected',
          connection: {
            id: existingConnection.id,
            status: 'ACCEPTED',
            message: null,
            createdAt: existingConnection.createdAt.toISOString(),
            user: receiver,
          },
          relationship: canonicalRelationship('connected', existingConnection.id),
        });
        return;
      }
      if (existingConnection.status === 'pending') {
        const relationshipStatus = existingConnection.requesterId === req.user.userId
          ? 'pending_sent'
          : 'pending_received';
        res.status(200).json({
          message: 'Connection request already pending',
          connection: {
            id: existingConnection.id,
            status: 'PENDING',
            message: null,
            createdAt: existingConnection.createdAt.toISOString(),
            user: receiver,
          },
          relationship: canonicalRelationship(relationshipStatus, existingConnection.id),
        });
        return;
      }
    }

    const limitState = await getConnectionRequestLimitState(req.user.userId);
    if (!limitState.allowed) {
      res.status(403).json({
        error: `Free accounts can send up to ${FREE_CONNECTION_REQUESTS_PER_DAY} connection requests per day. Upgrade to Premium for unlimited requests.`,
        code: 'connection_request_limit_reached',
        limit: limitState.limit,
        used: limitState.used,
        remaining: limitState.remaining,
      });
      return;
    }

    await enforceTrustTierLimit(req.user.userId, 'connection_request');

    const connection = existingConnection
      ? await prisma.connections.update({
          where: { id: existingConnection.id },
          data: {
            requesterId: req.user.userId,
            addresseeId: receiverId,
            status: 'pending',
            updatedAt: new Date(),
          },
        })
      : await prisma.connections.create({
          data: {
            id: randomUUID(),
            requesterId: req.user.userId,
            addresseeId: receiverId,
            status: 'pending',
            updatedAt: new Date(),
          },
        });

    // Send in-app notification (non-blocking)
    notificationService.notifyConnectionRequest(
      receiverId,
      req.user.userId,
      requester?.name || 'Someone'
    ).catch(console.error);

    // Send push notification (non-blocking)
    pushNotificationService.pushConnectionRequest(
      receiverId,
      requester?.name || 'Someone',
      connection.id
    ).catch(console.error);

    res.status(201).json({
      message: 'Connection request sent',
      connection: {
        id: connection.id,
        status: 'PENDING',
        message: message || null,
        createdAt: connection.createdAt.toISOString(),
        user: receiver,
      },
      relationship: canonicalRelationship('pending_sent', connection.id),
    });

    /*
     * Cache eviction happens after the response. The write is already durable,
     * and tag invalidation fans out across every discovery list both users
     * appear in — the caller gained nothing by waiting for it. It swallows its
     * own errors, so nothing here can affect the response already sent.
     */
    void invalidateDiscoveryCaches(req.user.userId, receiverId);
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('sendConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to send connection request' });
  }
};

export const acceptConnectionRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const connectionId = ensureString(req.params.connectionId);
    if (!connectionId) {
      res.status(400).json({ error: 'Connection ID required' });
      return;
    }

    const connection = await prisma.connections.findUnique({
      where: { id: connectionId },
      include: {
        users_connections_requesterIdTousers: {
          select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
        },
        users_connections_addresseeIdTousers: {
          select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
        },
      },
    });

    if (!connection) {
      res.status(404).json({ error: 'Connection request not found' });
      return;
    }

    if (connection.addresseeId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to accept this request' });
      return;
    }

    if (connection.status === 'accepted') {
      res.status(200).json({
        message: 'Connection request already accepted',
        connection: {
          id: connection.id,
          status: 'ACCEPTED',
          message: null,
          createdAt: connection.createdAt.toISOString(),
          user: connection.users_connections_requesterIdTousers,
        },
        relationship: canonicalRelationship('connected', connection.id),
      });
      return;
    }

    if (connection.status !== 'pending') {
      res.status(400).json({ error: 'Connection request is no longer pending' });
      return;
    }

    const accepted = await prisma.$transaction(async (tx) => {
      const acceptResult = await tx.connections.updateMany({
        where: { id: connectionId, addresseeId: req.user!.userId, status: 'pending' },
        data: { status: 'accepted' },
      });

      if (acceptResult.count !== 1) {
        return null;
      }

      // Persist one durable job in the same minimal transaction as the accept.
      await enqueueOutboxEvent(tx, {
        aggregateType: 'connection',
        aggregateId: connectionId,
        eventType: 'connection.accepted.side_effects',
        queueName: queueNames.connectionSideEffects,
        idempotencyKey: `connection:${connectionId}:accepted:side-effects`,
        payload: {
          connectionId,
          requesterId: connection.requesterId,
          addresseeId: connection.addresseeId,
          requester: connection.users_connections_requesterIdTousers,
          addressee: connection.users_connections_addresseeIdTousers,
        },
      });

      return true;
    });

    if (!accepted) {
      const latest = await prisma.connections.findUnique({ where: { id: connectionId } });
      if (latest?.status === 'accepted') {
        res.status(200).json({
          message: 'Connection request already accepted',
          connection: {
            id: connection.id,
            status: 'ACCEPTED',
            message: null,
            createdAt: connection.createdAt.toISOString(),
            user: connection.users_connections_requesterIdTousers,
          },
          relationship: canonicalRelationship('connected', connection.id),
        });
        return;
      }
      res.status(409).json({ error: 'Connection request changed; refresh and try again' });
      return;
    }

    res.status(200).json({
      message: 'Connection request accepted',
      connection: {
        id: connection.id,
        status: 'ACCEPTED',
        message: null,
        createdAt: connection.createdAt.toISOString(),
        user: connection.users_connections_requesterIdTousers,
      },
      relationship: canonicalRelationship('connected', connection.id),
    });
  } catch (error) {
    console.error('acceptConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to accept connection request' });
  }
};
