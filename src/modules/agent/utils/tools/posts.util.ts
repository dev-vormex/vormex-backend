import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { enforceTrustTierLimit } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { getCurrentUserContext } from "./context.util";
import { clip } from "./support.util";
import { actionRecord, switchTabIntent, maybeGateAction, safetyToolFailure } from "./policy.util";

export async function postsCreateTextTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const content = clip(String(args.content || ''), 3000);
      if (!content) {
        return {
          summary: 'I need post text before I can prepare a post.',
          output: {
            status: 'blocked',
            reason: 'missing_post_content',
          },
          blockedAction: actionRecord({
            type: 'post_create',
            toolName,
            status: 'blocked',
            title: 'Post content missing',
            summary: 'No post content was provided.',
            uiIntents: [switchTabIntent('post')],
          }),
          uiIntents: [switchTabIntent('post')],
        };
      }

      const requestedVisibility = String(args.visibility || 'public').trim().toLowerCase();
      const visibility = ['public', 'connections', 'private'].includes(requestedVisibility)
        ? requestedVisibility
        : 'public';
      args.content = content;
      args.visibility = visibility;

      const gated = maybeGateAction(toolName, ctx, {
        type: 'post_create',
        title: 'Approve post',
        summary: `Publish a ${visibility} text post.`,
        entityType: 'post',
        uiIntents: [switchTabIntent('post')],
        payload: {
          content,
          visibility,
        },
      });
      if (gated) return gated;

      try {
        await enforceTrustTierLimit(ctx.userId, 'post');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'post_create',
          title: 'Could not publish post',
        });
        if (failure) return failure;
        throw err;
      }

      const post = await prisma.post.create({
        data: {
          id: randomUUID(),
          authorId: ctx.userId,
          content,
          mediaUrls: [],
          metadata: {
            source: 'agent',
          },
          type: 'text',
          visibility,
        },
        select: {
          id: true,
          authorId: true,
          content: true,
          visibility: true,
          type: true,
          createdAt: true,
        },
      });

      return {
        summary: 'Published the text post.',
        output: {
          status: 'executed',
          post,
        },
        executedAction: actionRecord({
          type: 'post_create',
          toolName,
          status: 'executed',
          title: 'Published post',
          summary: 'Published the text post.',
          entityId: post.id,
          entityType: 'post',
          uiIntents: [switchTabIntent('feed')],
          payload: {
            postId: post.id,
            visibility,
          },
        }),
        uiIntents: [switchTabIntent('feed')],
      };
    }
