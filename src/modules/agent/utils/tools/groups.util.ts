import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { getCurrentUserContext } from "./context.util";
import { clip } from "./support.util";
import { actionRecord, switchTabIntent, maybeGateAction, openGroupIntent } from "./policy.util";

export async function groupsDiscoverTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
      const query = clip(args.query, 80) || '';
      const tag = clip(args.tag, 40) || '';

      const memberships = await prisma.group_members.findMany({
        where: { userId: ctx.userId },
        select: { groupId: true },
      });

      const groups = await prisma.groups.findMany({
        where: {
          id: { notIn: memberships.map((membership) => membership.groupId) },
          isPrivate: false,
          ...(query
            ? {
                OR: [
                  { name: { contains: query, mode: 'insensitive' } },
                  { description: { contains: query, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(tag ? { tags: { has: tag } } : {}),
        },
        orderBy: { memberCount: 'desc' },
        take: limit,
        select: {
          id: true,
          name: true,
          description: true,
          tags: true,
          memberCount: true,
        },
      });

      const summary =
        groups.length > 0
          ? `Found ${groups.length} groups${query ? ` for "${query}"` : ''}.`
          : 'No good group matches appeared yet.';

      return {
        summary,
        output: {
          status: 'executed',
          groups,
        },
        executedAction: actionRecord({
          type: 'discover_groups',
          toolName,
          status: 'executed',
          title: 'Discovered groups',
          summary,
          uiIntents: [switchTabIntent('groups')],
        }),
        uiIntents: [switchTabIntent('groups')],
      };
    }

export async function groupsJoinTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const groupId = String(args.groupId || '');
      if (!groupId) {
        return {
          summary: 'I need a group ID to join.',
          output: {
            status: 'blocked',
            reason: 'missing_group_id',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Could not join group',
            summary: 'No group ID was provided.',
          }),
        };
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'join_group',
        title: 'Prepared a group join',
        summary: 'I found the group and can join it.',
        entityId: groupId,
        entityType: 'group',
        uiIntents: [openGroupIntent(groupId)],
      });
      if (gated) return gated;

      const group = await prisma.groups.findUnique({
        where: {
          id: groupId,
        },
      });
      if (!group) {
        return {
          summary: 'That group could not be found.',
          output: {
            status: 'blocked',
            reason: 'group_not_found',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Group not found',
            summary: 'The requested group does not exist.',
            entityId: groupId,
            entityType: 'group',
          }),
        };
      }

      const existingMembership = await prisma.group_members.findUnique({
        where: {
          groupId_userId: {
            groupId,
            userId: ctx.userId,
          },
        },
      });
      if (existingMembership) {
        return {
          summary: 'You are already in that group.',
          output: {
            status: 'blocked',
            reason: 'already_joined',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Already joined group',
            summary: 'The current user is already a member of this group.',
            entityId: groupId,
            entityType: 'group',
          }),
        };
      }

      if (group.isPrivate) {
        return {
          summary: 'Private groups require an invitation.',
          output: {
            status: 'blocked',
            reason: 'private_group_requires_invitation',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Group requires invitation',
            summary: 'Private groups cannot be joined without an invitation.',
            entityId: groupId,
            entityType: 'group',
          }),
        };
      }

      if (group.memberCount >= group.maxMembers) {
        return {
          summary: 'That group is full.',
          output: {
            status: 'blocked',
            reason: 'group_full',
          },
          blockedAction: actionRecord({
            type: 'join_group',
            toolName,
            status: 'blocked',
            title: 'Group is full',
            summary: 'The group has reached its member limit.',
            entityId: groupId,
            entityType: 'group',
          }),
        };
      }

      await prisma.$transaction([
        prisma.group_members.create({
          data: {
            id: randomUUID(),
            groupId,
            userId: ctx.userId,
            role: 'member',
          },
        }),
        prisma.groups.update({
          where: { id: groupId },
          data: {
            memberCount: {
              increment: 1,
            },
          },
        }),
      ]);

      const uiIntents = [openGroupIntent(groupId)];
      const summary = 'Joined the group.';
      return {
        summary,
        output: {
          status: 'executed',
          groupId,
        },
        executedAction: actionRecord({
          type: 'join_group',
          toolName,
          status: 'executed',
          title: 'Joined group',
          summary,
          entityId: groupId,
          entityType: 'group',
          uiIntents,
        }),
        uiIntents,
      };
    }
