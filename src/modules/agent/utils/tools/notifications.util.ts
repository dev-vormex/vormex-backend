import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { prisma } from "../../../../config/prisma";
import { getCurrentUserContext } from "./context.util";
import { actionRecord, maybeGateAction } from "./policy.util";

export async function notificationsGetSummaryTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
      const unreadOnly = Boolean(args.unreadOnly);
      const [count, notifications] = await Promise.all([
        prisma.notifications.count({
          where: {
            userId: ctx.userId,
            ...(unreadOnly ? { isRead: false } : {}),
          },
        }),
        prisma.notifications.findMany({
          where: {
            userId: ctx.userId,
            ...(unreadOnly ? { isRead: false } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            isRead: true,
            createdAt: true,
          },
        }),
      ]);

      return {
        summary: `Loaded ${notifications.length} notifications.`,
        output: {
          status: 'executed',
          total: count,
          notifications: notifications.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
          })),
        },
        executedAction: actionRecord({
          type: 'notifications_summary',
          toolName,
          status: 'executed',
          title: 'Loaded notifications',
          summary: `Loaded ${notifications.length} notifications.`,
          uiIntents: [
            {
              type: 'open_notifications',
            },
          ],
        }),
        uiIntents: [
          {
            type: 'open_notifications',
          },
        ],
      };
    }

export async function notificationsMarkAllReadTool(toolName: string, _args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const gated = maybeGateAction(toolName, ctx, {
        type: 'notifications_mark_all_read',
        title: 'Prepared to mark notifications as read',
        summary: 'I can mark the current notifications as read.',
        uiIntents: [
          {
            type: 'open_notifications',
          },
        ],
      });
      if (gated) return gated;

      const result = await prisma.notifications.updateMany({
        where: {
          userId: ctx.userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      return {
        summary: 'Marked notifications as read.',
        output: {
          status: 'executed',
          updatedCount: result.count,
        },
        executedAction: actionRecord({
          type: 'notifications_mark_all_read',
          toolName,
          status: 'executed',
          title: 'Marked notifications as read',
          summary: 'Marked notifications as read.',
          uiIntents: [
            {
              type: 'open_notifications',
            },
          ],
        }),
        uiIntents: [
          {
            type: 'open_notifications',
          },
        ],
      };
    }
