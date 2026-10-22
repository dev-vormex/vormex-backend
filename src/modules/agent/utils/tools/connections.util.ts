import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { prisma } from "../../../../config/prisma";
import { assertUsersCanInteract, enforceTrustTierLimit } from "../../../safety/services/trust-safety.service";
import { getConnectionRequestLimitState, FREE_CONNECTION_REQUESTS_PER_DAY } from "../../../safety/services/tier-limits.service";
import { randomUUID } from "crypto";
import { getCurrentUserContext } from "./context.util";
import { actionRecord, safetyToolFailure, maybeGateAction, openProfileIntent, switchTabIntent } from "./policy.util";

export async function connectionsSendRequestTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const targetUserId = String(args.userId || '');
      if (!targetUserId || targetUserId === ctx.userId) {
        return {
          summary: 'I need a valid user to send a connection request.',
          output: {
            status: 'blocked',
            reason: 'invalid_user',
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Could not send connection request',
            summary: 'The requested user ID was invalid.',
          }),
        };
      }

      const requestTarget = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true },
      });
      if (!requestTarget) {
        return {
          summary: 'That user could not be found.',
          output: {
            status: 'blocked',
            reason: 'user_not_found',
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Could not send connection request',
            summary: 'The requested user does not exist.',
            entityId: targetUserId,
            entityType: 'user',
          }),
        };
      }

      try {
        await assertUsersCanInteract(ctx.userId, targetUserId, 'connection request');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'send_connection_request',
          title: 'Could not send connection request',
          entityId: targetUserId,
          entityType: 'user',
        });
        if (failure) return failure;
        throw err;
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'send_connection_request',
        title: 'Prepared a connection request',
        summary: 'I found the user and prepared the connection request.',
        entityId: targetUserId,
        entityType: 'user',
        uiIntents: [openProfileIntent(targetUserId)],
      });
      if (gated) return gated;

      const existing = await prisma.connections.findFirst({
        where: {
          OR: [
            { requesterId: ctx.userId, addresseeId: targetUserId },
            { requesterId: targetUserId, addresseeId: ctx.userId },
          ],
        },
      });
      if (existing) {
        return {
          summary: 'A connection already exists or is already pending.',
          output: {
            status: 'blocked',
            reason: 'already_connected_or_pending',
            connectionId: existing.id,
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Connection request not sent',
            summary: 'This connection is already pending or already accepted.',
            entityId: existing.id,
            entityType: 'connection',
          }),
        };
      }

      const limitState = await getConnectionRequestLimitState(ctx.userId);
      if (!limitState.allowed) {
        return {
          summary: `Free accounts can send up to ${FREE_CONNECTION_REQUESTS_PER_DAY} connection requests per day. Premium unlocks unlimited requests.`,
          output: {
            status: 'blocked',
            reason: 'connection_request_limit_reached',
            limit: limitState.limit,
            used: limitState.used,
            remaining: limitState.remaining,
          },
          blockedAction: actionRecord({
            type: 'send_connection_request',
            toolName,
            status: 'blocked',
            title: 'Connection request limit reached',
            summary: 'The daily free connection request limit has been reached.',
          }),
        };
      }

      try {
        await enforceTrustTierLimit(ctx.userId, 'connection_request');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'send_connection_request',
          title: 'Could not send connection request',
          entityId: targetUserId,
          entityType: 'user',
        });
        if (failure) return failure;
        throw err;
      }

      const connection = await prisma.connections.create({
        data: {
          id: randomUUID(),
          requesterId: ctx.userId,
          addresseeId: targetUserId,
          status: 'pending',
        },
      });

      const uiIntents = [openProfileIntent(targetUserId), switchTabIntent('find')];
      const summary = 'Sent the connection request.';
      return {
        summary,
        output: {
          status: 'executed',
          connectionId: connection.id,
        },
        executedAction: actionRecord({
          type: 'send_connection_request',
          toolName,
          status: 'executed',
          title: 'Sent connection request',
          summary,
          entityId: connection.id,
          entityType: 'connection',
          uiIntents,
        }),
        uiIntents,
      };
    }

export async function connectionsAcceptRequestTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const connectionId = String(args.connectionId || '');
      if (!connectionId) {
        return {
          summary: 'I need a connection ID to accept the request.',
          output: {
            status: 'blocked',
            reason: 'missing_connection_id',
          },
          blockedAction: actionRecord({
            type: 'accept_connection_request',
            toolName,
            status: 'blocked',
            title: 'Could not accept request',
            summary: 'No connection ID was provided.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'accept_connection_request',
        title: 'Prepared to accept a connection request',
        summary: 'I found the pending connection request and can accept it.',
        entityId: connectionId,
        entityType: 'connection',
        uiIntents: [switchTabIntent('find')],
      });
      if (gated) return gated;

      const connection = await prisma.connections.findFirst({
        where: {
          id: connectionId,
          addresseeId: ctx.userId,
        },
      });

      if (!connection || connection.status !== 'pending') {
        return {
          summary: 'That connection request is no longer available.',
          output: {
            status: 'blocked',
            reason: 'connection_not_pending',
          },
          blockedAction: actionRecord({
            type: 'accept_connection_request',
            toolName,
            status: 'blocked',
            title: 'Connection request unavailable',
            summary: 'The request was not found or is no longer pending.',
            entityId: connectionId,
            entityType: 'connection',
          }),
        };
      }

      try {
        await assertUsersCanInteract(ctx.userId, connection.requesterId, 'connection request');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'accept_connection_request',
          title: 'Could not accept request',
          entityId: connectionId,
          entityType: 'connection',
        });
        if (failure) return failure;
        throw err;
      }

      await prisma.$transaction([
        prisma.connections.update({
          where: { id: connectionId },
          data: { status: 'accepted' },
        }),
        prisma.userStats.updateMany({
          where: {
            userId: {
              in: [connection.requesterId, connection.addresseeId],
            },
          },
          data: {
            connectionsCount: { increment: 1 },
          },
        }),
      ]);

      const summary = 'Accepted the connection request.';
      return {
        summary,
        output: {
          status: 'executed',
          connectionId,
        },
        executedAction: actionRecord({
          type: 'accept_connection_request',
          toolName,
          status: 'executed',
          title: 'Accepted connection request',
          summary,
          entityId: connectionId,
          entityType: 'connection',
          uiIntents: [switchTabIntent('find')],
        }),
        uiIntents: [switchTabIntent('find')],
      };
    }
