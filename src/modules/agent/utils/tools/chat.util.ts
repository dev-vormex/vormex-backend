import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { assertUsersCanInteract, enforceTrustTierLimit } from "../../../safety/services/trust-safety.service";
import { getOrCreateConversationForUsers } from "../../../chat/services/conversation-pair.service";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { getCurrentUserContext } from "./context.util";
import { actionRecord, safetyToolFailure, maybeGateAction, openChatIntent } from "./policy.util";
import { clip } from "./support.util";

export async function chatOpenConversationTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const targetUserId = String(args.userId || '');
      if (!targetUserId || targetUserId === ctx.userId) {
        return {
          summary: 'I need a valid other user to open chat.',
          output: {
            status: 'blocked',
            reason: 'invalid_user',
          },
          blockedAction: actionRecord({
            type: 'open_chat',
            toolName,
            status: 'blocked',
            title: 'Could not open chat',
            summary: 'The requested user was invalid.',
          }),
        };
      }

      try {
        await assertUsersCanInteract(ctx.userId, targetUserId, 'message');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'open_chat',
          title: 'Could not open chat',
          entityId: targetUserId,
          entityType: 'user',
        });
        if (failure) return failure;
        throw err;
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'open_chat',
        title: 'Prepared a chat handoff',
        summary: 'I found the user and can open the chat thread.',
        entityId: targetUserId,
        entityType: 'user',
        uiIntents: [openChatIntent({ userId: targetUserId })],
      });
      if (gated) return gated;

      try {
        await enforceTrustTierLimit(ctx.userId, 'dm');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'open_chat',
          title: 'Could not open chat',
          entityId: targetUserId,
          entityType: 'user',
        });
        if (failure) return failure;
        throw err;
      }

      const conversation = await getOrCreateConversationForUsers(ctx.userId, targetUserId);
      const uiIntents = [openChatIntent({ userId: targetUserId, conversationId: conversation.id })];
      const summary = 'Opened the chat thread.';
      return {
        summary,
        output: {
          status: 'executed',
          conversationId: conversation.id,
          targetUserId,
        },
        executedAction: actionRecord({
          type: 'open_chat',
          toolName,
          status: 'executed',
          title: 'Opened chat',
          summary,
          entityId: conversation.id,
          entityType: 'conversation',
          uiIntents,
        }),
        uiIntents,
      };
    }

export async function chatSendMessageTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const targetUserId = String(args.userId || '');
      const message = clip(String(args.message || ''), 1000);
      if (!targetUserId || !message || targetUserId === ctx.userId) {
        return {
          summary: 'I need a valid user and message before sending.',
          output: {
            status: 'blocked',
            reason: 'invalid_message_request',
          },
          blockedAction: actionRecord({
            type: 'send_message',
            toolName,
            status: 'blocked',
            title: 'Could not send message',
            summary: 'The message request was incomplete.',
          }),
        };
      }

      try {
        await assertUsersCanInteract(ctx.userId, targetUserId, 'message');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'send_message',
          title: 'Could not send message',
          entityId: targetUserId,
          entityType: 'user',
        });
        if (failure) return failure;
        throw err;
      }

      const gated = maybeGateAction(toolName, ctx, {
        type: 'send_message',
        title: 'Prepared a direct message',
        summary: 'I drafted the message and can send it when autonomous actions are enabled.',
        entityId: targetUserId,
        entityType: 'user',
        uiIntents: [openChatIntent({ userId: targetUserId })],
        payload: {
          message,
        },
      });
      if (gated) return gated;

      try {
        await enforceTrustTierLimit(ctx.userId, 'dm');
      } catch (err) {
        const failure = safetyToolFailure(err, {
          toolName,
          type: 'send_message',
          title: 'Could not send message',
          entityId: targetUserId,
          entityType: 'user',
        });
        if (failure) return failure;
        throw err;
      }

      const conversation = await getOrCreateConversationForUsers(ctx.userId, targetUserId);
      const receiverId =
        conversation.participant1Id === ctx.userId
          ? conversation.participant2Id
          : conversation.participant1Id;

      const createdMessage = await prisma.messages.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          senderId: ctx.userId,
          receiverId,
          content: message,
          contentType: 'text',
          status: 'SENT',
        },
      });

      await prisma.conversations.update({
        where: {
          id: conversation.id,
        },
        data: {
          lastMessageAt: new Date(),
        },
      });

      const uiIntents = [
        openChatIntent({
          userId: targetUserId,
          conversationId: conversation.id,
        }),
      ];
      const summary = 'Sent the direct message.';
      return {
        summary,
        output: {
          status: 'executed',
          conversationId: conversation.id,
          messageId: createdMessage.id,
          content: message,
        },
        executedAction: actionRecord({
          type: 'send_message',
          toolName,
          status: 'executed',
          title: 'Sent direct message',
          summary,
          entityId: createdMessage.id,
          entityType: 'message',
          uiIntents,
          payload: {
            conversationId: conversation.id,
          },
        }),
        uiIntents,
      };
    }
