import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ChatMessage, aiService } from "../../services/ai.service";
import { getRequestId } from "../../../../infrastructure/logging/logger";
import { ensureAuthenticatedUserId, CareerHistoryItem, clampText, CAREER_MESSAGE_LIMIT, sendRequestError, getUserProfile, buildBoundedText, formatUserContext, UTILITY_CONTEXT_LIMIT, normalizeCareerHistory, CAREER_TIMEOUT_MS, sendAIError } from "./support.controller";

export const careerChat = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { conversationHistory, message } = req.body as {
      conversationHistory?: CareerHistoryItem[];
      message?: string;
    };

    const userMessage = clampText(message, CAREER_MESSAGE_LIMIT);

    if (!userMessage) {
      sendRequestError(req, res, 400, 'message is required', 'ai_invalid_input');
      return;
    }

    const userProfile = await getUserProfile(userId);
    const profileContext = buildBoundedText(
      [formatUserContext('Current user profile', userProfile)],
      UTILITY_CONTEXT_LIMIT
    );
    const normalizedHistory = normalizeCareerHistory(Array.isArray(conversationHistory) ? conversationHistory : []);

    const history: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are Vormex AI, a friendly and knowledgeable career assistant built into the Vormex professional networking platform.',
          'You help students and professionals with career advice, resume tips, interview preparation, networking strategies, job search, skill development, and professional growth.',
          'Be warm, concise, and actionable.',
          'Keep responses focused and under 200 words unless the user asks for detailed depth.',
          `User profile context:\n${profileContext || 'No profile context available.'}`,
        ].join('\n\n'),
      },
      ...normalizedHistory,
      { role: 'user', content: userMessage },
    ];

    const reply = await aiService.complete(history, {
      maxTokens: 500,
      metadata: {
        requestId: getRequestId(req),
        route: 'career-chat',
        userId,
      },
      reasoningEffort: 'medium',
      timeoutMs: CAREER_TIMEOUT_MS,
    });

    res.json({ reply });
  } catch (error) {
    sendAIError(req, res, error);
  }
};
