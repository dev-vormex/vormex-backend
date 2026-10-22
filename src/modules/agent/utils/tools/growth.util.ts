import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { prisma } from "../../../../config/prisma";
import { getCurrentUserContext } from "./context.util";
import { actionRecord, openGrowthIntent } from "./policy.util";

export async function growthGetSnapshotTool(toolName: string, _args: Record<string, any>, ctx: AgentToolExecutionContext, currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const [connectionCount, pendingConnections, unreadNotifications, partnerCount, postCount] =
        await Promise.all([
          prisma.connections.count({
            where: {
              OR: [{ requesterId: ctx.userId }, { addresseeId: ctx.userId }],
              status: 'accepted',
            },
          }),
          prisma.connections.count({
            where: {
              addresseeId: ctx.userId,
              status: 'pending',
            },
          }),
          prisma.notifications.count({
            where: {
              userId: ctx.userId,
              isRead: false,
            },
          }),
          prisma.accountability_pairs.count({
            where: {
              status: 'active',
              OR: [{ user1Id: ctx.userId }, { user2Id: ctx.userId }],
            },
          }),
          prisma.post.count({
            where: {
              authorId: ctx.userId,
            },
          }),
        ]);

      const hooks: string[] = [];
      if (!currentUser?.bio || currentUser.bio.trim().length < 20) {
        hooks.push('Add a sharper bio to improve discoverability.');
      }
      if (!currentUser?.profileImage) {
        hooks.push('Add a profile picture so people trust your outreach faster.');
      }
      if (connectionCount < 5) {
        hooks.push('Grow your network by connecting with a few aligned peers.');
      }
      if (postCount === 0) {
        hooks.push('Publish your first post to start getting inbound attention.');
      }

      const snapshot = {
        profileReady: Boolean(currentUser?.profileImage) && Boolean(currentUser?.bio),
        connectionCount,
        pendingConnections,
        unreadNotifications,
        accountabilityPartners: partnerCount,
        postCount,
        hooks,
      };

      return {
        summary: 'Loaded the growth snapshot.',
        output: {
          status: 'executed',
          snapshot,
        },
        executedAction: actionRecord({
          type: 'growth_snapshot',
          toolName,
          status: 'executed',
          title: 'Loaded growth snapshot',
          summary: 'Loaded the current growth snapshot.',
          uiIntents: [openGrowthIntent()],
        }),
        uiIntents: [openGrowthIntent()],
      };
    }
