import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { assertCanViewUser, SafetyActionError } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { getCurrentUserContext, getAgentCurrentUserContext, summarizeUser } from "./context.util";
import { actionRecord, switchTabIntent, openProfileIntent, maybeGateAction } from "./policy.util";
import { agentUserSelect } from "./schemas.util";
import { clip } from "./support.util";
import { normalizeProfileInterestsForAgent } from "./prompt.util";

export async function profileGetMeTool(toolName: string, _args: Record<string, any>, ctx: AgentToolExecutionContext, currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const currentUserContext = await getAgentCurrentUserContext(ctx.userId);
      return {
        summary: 'Loaded your full profile context.',
        output: {
          status: 'executed',
          profile: currentUserContext?.snapshot || summarizeUser(currentUser, currentUser),
        },
        executedAction: actionRecord({
          type: 'profile_lookup',
          toolName,
          status: 'executed',
          title: 'Loaded your profile context',
          summary: 'Loaded your full profile context.',
          uiIntents: [switchTabIntent('profile')],
        }),
        uiIntents: [switchTabIntent('profile')],
      };
    }

export async function profileGetUserTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const targetUserId = String(args.userId || '');
      let targetHidden = false;
      try {
        await assertCanViewUser(ctx.userId, targetUserId);
      } catch (err) {
        if (!(err instanceof SafetyActionError)) throw err;
        targetHidden = true;
      }
      const user = targetHidden
        ? null
        : await prisma.user.findUnique({
            where: {
              id: targetUserId,
            },
            select: agentUserSelect,
          });

      if (!user) {
        return {
          summary: 'That user profile could not be found.',
          output: {
            status: 'blocked',
            reason: 'user_not_found',
          },
          blockedAction: actionRecord({
            type: 'profile_lookup',
            toolName,
            status: 'blocked',
            title: 'Profile not found',
            summary: 'The requested user profile does not exist.',
            entityId: targetUserId,
            entityType: 'user',
          }),
        };
      }

      const uiIntents = [openProfileIntent(targetUserId)];
      return {
        summary: 'Loaded the requested profile.',
        output: {
          status: 'executed',
          profile: summarizeUser(user, currentUser),
        },
        executedAction: actionRecord({
          type: 'profile_lookup',
          toolName,
          status: 'executed',
          title: 'Loaded profile',
          summary: 'Loaded the requested user profile.',
          entityId: targetUserId,
          entityType: 'user',
          uiIntents,
        }),
        uiIntents,
      };
    }

export async function profileUpdateSummaryTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const headline =
        args.headline !== undefined && args.headline !== null ? clip(String(args.headline), 120) : undefined;
      const bio = args.bio !== undefined && args.bio !== null ? clip(String(args.bio), 500) : undefined;
      const interests = normalizeProfileInterestsForAgent(args.interests);
      const updateData: Record<string, unknown> = {};

      if (headline !== undefined) updateData.headline = headline;
      if (bio !== undefined) updateData.bio = bio;
      if (interests !== undefined) updateData.interests = interests;

      const updatedFields = Object.keys(updateData);
      if (updatedFields.length === 0) {
        return {
          summary: 'I need at least one profile field to update.',
          output: {
            status: 'blocked',
            reason: 'missing_profile_update_fields',
          },
          blockedAction: actionRecord({
            type: 'profile_update',
            toolName,
            status: 'blocked',
            title: 'Profile update missing',
            summary: 'No supported profile fields were provided.',
            uiIntents: [switchTabIntent('profile')],
          }),
          uiIntents: [switchTabIntent('profile')],
        };
      }

      args.headline = headline ?? null;
      args.bio = bio ?? null;
      args.interests = interests ?? null;

      const summary = `Update your profile ${updatedFields.join(', ')}.`;
      const gated = maybeGateAction(toolName, ctx, {
        type: 'profile_update',
        title: 'Approve profile update',
        summary,
        entityId: ctx.userId,
        entityType: 'user',
        uiIntents: [switchTabIntent('profile')],
        payload: {
          fields: updatedFields,
          preview: updateData,
        },
      });
      if (gated) return gated;

      const updatedUser = await prisma.user.update({
        where: { id: ctx.userId },
        data: updateData,
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          headline: true,
          bio: true,
          interests: true,
          updatedAt: true,
        },
      });

      return {
        summary: `Updated your profile ${updatedFields.join(', ')}.`,
        output: {
          status: 'executed',
          profile: updatedUser,
          fields: updatedFields,
        },
        executedAction: actionRecord({
          type: 'profile_update',
          toolName,
          status: 'executed',
          title: 'Updated profile',
          summary: `Updated your profile ${updatedFields.join(', ')}.`,
          entityId: ctx.userId,
          entityType: 'user',
          uiIntents: [switchTabIntent('profile')],
          payload: {
            fields: updatedFields,
          },
        }),
        uiIntents: [switchTabIntent('profile')],
      };
    }
