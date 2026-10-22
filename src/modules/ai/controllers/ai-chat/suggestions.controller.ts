import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureAuthenticatedUserId, clampText, UTILITY_CONTEXT_LIMIT, UTILITY_MESSAGE_LIMIT, getUserProfile, sendRequestError, buildBoundedText, formatUserContext, requestSuggestions, FALLBACK_STARTERS, sendAIError, getConversationContext, buildConversationTranscript, FALLBACK_REVIVALS, FALLBACK_REPLIES } from "./support.controller";

export const getConversationStarters = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { context, goal, otherUserId } = req.body as {
      context?: string;
      goal?: string;
      otherUserId?: string;
    };

    let promptContext = clampText(context, UTILITY_CONTEXT_LIMIT);
    const normalizedGoal =
      clampText(goal, UTILITY_MESSAGE_LIMIT) || 'start a meaningful professional conversation';

    if (!promptContext && otherUserId) {
      const [currentUser, otherUser] = await Promise.all([
        getUserProfile(userId),
        getUserProfile(String(otherUserId)),
      ]);

      if (!otherUser) {
        sendRequestError(req, res, 404, 'Other user not found.', 'not_found');
        return;
      }

      promptContext = buildBoundedText(
        [
          formatUserContext('Current user profile', currentUser),
          formatUserContext('Target user profile', otherUser),
        ],
        UTILITY_CONTEXT_LIMIT
      );
    }

    const starters = await requestSuggestions(req, {
      fallback: FALLBACK_STARTERS,
      limit: 3,
      route: 'conversation-starters',
      systemPrompt:
        'You write thoughtful first messages for student/professional networking chats. The sender wants a real collaboration or helpful connection, not a generic greeting. Return ONLY a JSON array of strings.',
      userPrompt: [
        `User goal: ${normalizedGoal}`,
        `Context: ${promptContext || 'No extra context provided.'}`,
        'Generate 3 options, each 28-45 words.',
        'Each message should be warm, specific to the two profiles when possible, and show a clear reason the recipient may benefit from replying.',
        'Avoid empty greetings like "hi", flattery-only lines, sales language, and over-formal wording.',
      ].join('\n'),
      temperature: 0.75,
    });

    res.json({ starters });
  } catch (error) {
    sendAIError(req, res, error);
  }
};

export const getRevivalSuggestions = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { context, conversationId, lastMessageAt, otherUserId } = req.body as {
      context?: string;
      conversationId?: string;
      lastMessageAt?: string;
      otherUserId?: string;
    };

    let promptContext = clampText(context, UTILITY_CONTEXT_LIMIT);
    let lastActivity = clampText(lastMessageAt, UTILITY_MESSAGE_LIMIT) || 'unknown';

    if (conversationId) {
      const conversation = await getConversationContext(userId, String(conversationId), 6);
      if (!conversation) {
        sendRequestError(req, res, 404, 'Conversation not found.', 'not_found');
        return;
      }

      const derivedOtherUserId =
        conversation.participant1Id === userId ? conversation.participant2Id : conversation.participant1Id;
      const [currentUser, otherUser] = await Promise.all([
        getUserProfile(userId),
        getUserProfile(otherUserId ? String(otherUserId) : derivedOtherUserId),
      ]);

      lastActivity = conversation.lastMessageAt?.toISOString() || lastActivity;
      promptContext = buildBoundedText(
        [
          formatUserContext('Current user profile', currentUser),
          formatUserContext('Other participant profile', otherUser),
          buildConversationTranscript(conversation, userId, otherUser?.name || 'Other person'),
        ],
        UTILITY_CONTEXT_LIMIT
      );
    }

    const suggestions = await requestSuggestions(req, {
      fallback: FALLBACK_REVIVALS,
      limit: 3,
      route: 'revival-suggestions',
      systemPrompt:
        'You revive dormant chats politely and confidently. Return ONLY a JSON array of strings.',
      userPrompt: [
        `Last known activity time: ${lastActivity}`,
        `Conversation context: ${promptContext || 'No additional context.'}`,
        'Generate 3 short revival messages, each <= 20 words, friendly and low-pressure.',
      ].join('\n'),
    });

    res.json({ suggestions });
  } catch (error) {
    sendAIError(req, res, error);
  }
};

export const getSmartReplies = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { context, conversationId, lastMessage } = req.body as {
      context?: string;
      conversationId?: string;
      lastMessage?: string;
    };

    const normalizedMessage = clampText(lastMessage, UTILITY_MESSAGE_LIMIT);

    if (!normalizedMessage) {
      sendRequestError(req, res, 400, 'lastMessage is required', 'ai_invalid_input');
      return;
    }

    let promptContext = clampText(context, UTILITY_CONTEXT_LIMIT);

    if (conversationId) {
      const conversation = await getConversationContext(userId, String(conversationId), 4);
      if (!conversation) {
        sendRequestError(req, res, 404, 'Conversation not found.', 'not_found');
        return;
      }

      const otherParticipant =
        conversation.participant1Id === userId
          ? conversation.users_conversations_participant2IdTousers
          : conversation.users_conversations_participant1IdTousers;

      promptContext = buildBoundedText(
        [
          `Conversation snippet with ${otherParticipant?.name || 'the other person'}:`,
          buildConversationTranscript(conversation, userId, otherParticipant?.name || 'Other person'),
        ],
        UTILITY_CONTEXT_LIMIT
      );
    }

    const replies = await requestSuggestions(req, {
      fallback: FALLBACK_REPLIES,
      limit: 4,
      route: 'smart-replies',
      systemPrompt:
        'You generate concise, relevant chat replies for social networking. Return ONLY a JSON array of strings.',
      userPrompt: [
        `Last message to reply to: ${normalizedMessage}`,
        `Extra context: ${promptContext || 'none'}`,
        'Generate 4 candidate replies. Each must be <= 14 words and sound natural.',
      ].join('\n'),
    });

    res.json({ replies });
  } catch (error) {
    sendAIError(req, res, error);
  }
};
