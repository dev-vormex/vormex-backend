import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { getCurrentUserContext } from "./context.util";
import { peopleSearchTool, matchingFindLikeMindedPeersTool } from "./search.util";
import { connectionsSendRequestTool, connectionsAcceptRequestTool } from "./connections.util";
import { chatOpenConversationTool, chatSendMessageTool } from "./chat.util";
import { groupsDiscoverTool, groupsJoinTool } from "./groups.util";
import { profileGetMeTool, profileGetUserTool, profileUpdateSummaryTool } from "./profiles.util";
import { postsCreateTextTool } from "./posts.util";
import { growthGetSnapshotTool } from "./growth.util";
import { notificationsGetSummaryTool, notificationsMarkAllReadTool } from "./notifications.util";
import { uiNavigateTool } from "./navigation.util";
import { actionRecord } from "./policy.util";

export async function executeAgentTool(
  toolName: string,
  args: Record<string, any>,
  ctx: AgentToolExecutionContext
): Promise<AgentToolResult> {
  const currentUser = await getCurrentUserContext(ctx.userId);

  switch (toolName) {
case 'people_search': return peopleSearchTool(toolName, args, ctx, currentUser);
case 'matching_find_like_minded_peers': return matchingFindLikeMindedPeersTool(toolName, args, ctx, currentUser);
case 'connections_send_request': return connectionsSendRequestTool(toolName, args, ctx, currentUser);
case 'connections_accept_request': return connectionsAcceptRequestTool(toolName, args, ctx, currentUser);
case 'chat_open_conversation': return chatOpenConversationTool(toolName, args, ctx, currentUser);
case 'chat_send_message': return chatSendMessageTool(toolName, args, ctx, currentUser);
case 'groups_discover': return groupsDiscoverTool(toolName, args, ctx, currentUser);
case 'groups_join': return groupsJoinTool(toolName, args, ctx, currentUser);
case 'profile_get_me': return profileGetMeTool(toolName, args, ctx, currentUser);
case 'profile_get_user': return profileGetUserTool(toolName, args, ctx, currentUser);
case 'profile_update_summary': return profileUpdateSummaryTool(toolName, args, ctx, currentUser);
case 'posts_create_text': return postsCreateTextTool(toolName, args, ctx, currentUser);
case 'growth_get_snapshot': return growthGetSnapshotTool(toolName, args, ctx, currentUser);
case 'notifications_get_summary': return notificationsGetSummaryTool(toolName, args, ctx, currentUser);
case 'notifications_mark_all_read': return notificationsMarkAllReadTool(toolName, args, ctx, currentUser);
case 'ui_navigate': return uiNavigateTool(toolName, args, ctx, currentUser);
default:
      return {
        summary: `Tool ${toolName} is not implemented.`,
        output: {
          status: 'blocked',
          reason: 'tool_not_implemented',
          toolName,
        },
        blockedAction: actionRecord({
          type: 'tool_missing',
          toolName,
          status: 'blocked',
          title: 'Tool unavailable',
          summary: `The tool ${toolName} is not implemented.`,
        }),
      };
}
}
