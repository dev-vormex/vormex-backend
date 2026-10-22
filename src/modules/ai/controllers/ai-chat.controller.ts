/** Stable import surface; implementations are grouped by responsibility. */
export { getConversationStarters, getRevivalSuggestions, getSmartReplies } from './ai-chat/suggestions.controller';
export { fixGrammar, changeTone, translateMessage, expandMessage } from './ai-chat/editing.controller';
export { assistantChat } from './ai-chat/assistant.controller';
export { careerChat } from './ai-chat/career.controller';
