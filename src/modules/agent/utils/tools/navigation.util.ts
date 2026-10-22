import { AgentToolExecutionContext, AgentToolResult, AgentUiIntent } from "../../types";
import { getCurrentUserContext } from "./context.util";
import { switchTabIntent, openProfileIntent, openChatIntent, openGroupIntent, openGrowthIntent, actionRecord } from "./policy.util";

export async function uiNavigateTool(toolName: string, args: Record<string, any>, _ctx: AgentToolExecutionContext, _currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const target = String(args.target || '').toLowerCase();
      let uiIntent: AgentUiIntent | null = null;

      switch (target) {
        case 'feed':
        case 'home':
          uiIntent = switchTabIntent('feed');
          break;
        case 'find_people':
        case 'network':
        case 'find':
          uiIntent = switchTabIntent('find');
          break;
        case 'post':
        case 'create_post':
          uiIntent = switchTabIntent('post');
          break;
        case 'profile':
          uiIntent = args.userId ? openProfileIntent(String(args.userId)) : switchTabIntent('profile');
          break;
        case 'chat':
        case 'messages':
          uiIntent = openChatIntent({
            userId: args.userId ? String(args.userId) : undefined,
            conversationId: args.conversationId ? String(args.conversationId) : undefined,
          });
          break;
        case 'groups':
          uiIntent = args.groupId ? openGroupIntent(String(args.groupId)) : { type: 'open_groups' };
          break;
        case 'notifications':
          uiIntent = { type: 'open_notifications' };
          break;
        case 'growth_hub':
        case 'growth':
          uiIntent = openGrowthIntent(String(args.note || 'Open Growth Hub'));
          break;
        default:
          break;
      }

      if (!uiIntent) {
        return {
          summary: 'That navigation target is not supported yet.',
          output: {
            status: 'blocked',
            reason: 'unsupported_navigation_target',
            target,
          },
          blockedAction: actionRecord({
            type: 'navigate',
            toolName,
            status: 'blocked',
            title: 'Unsupported navigation target',
            summary: `The target "${target}" is not currently supported.`,
          }),
        };
      }

      return {
        summary: 'Prepared the UI handoff.',
        output: {
          status: 'executed',
          uiIntent,
        },
        executedAction: actionRecord({
          type: 'navigate',
          toolName,
          status: 'executed',
          title: 'Prepared navigation',
          summary: 'Prepared the UI handoff.',
          uiIntents: [uiIntent],
        }),
        uiIntents: [uiIntent],
      };
    }
