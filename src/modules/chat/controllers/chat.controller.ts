/** Stable import surface; implementations are grouped by responsibility. */
export { buildChatUserIdentity } from './chat/support.controller';
export { getConversations, getOrCreateConversation } from './chat/conversations.controller';
export { getConversationStatusWithUser, getConversation } from './chat/conversation-read.controller';
export { syncChat, getMessages, searchMessages } from './chat/message-read.controller';
export { sendMessage, deleteMessage, editMessage, addReaction } from './chat/message-write.controller';
export { markAsRead, getUnreadCount, getMessageLimitStatus } from './chat/read-state.controller';
export { deleteConversation } from './chat/conversation-delete.controller';
export {
  getMessageRequests,
  getMessageRequestsCount,
  acceptMessageRequest,
  declineMessageRequest,
} from './chat/requests.controller';
