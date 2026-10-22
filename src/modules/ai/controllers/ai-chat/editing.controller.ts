import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { aiService } from "../../services/ai.service";
import { getRequestId } from "../../../../infrastructure/logging/logger";
import { ensureAuthenticatedUserId, clampText, UTILITY_MESSAGE_LIMIT, UTILITY_CONTEXT_LIMIT, sendRequestError, UTILITY_TIMEOUT_MS, extractJsonObject, sendAIError, DEFAULT_TONE } from "./support.controller";

export const fixGrammar = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { context, message } = req.body as { context?: string; message?: string };
    const original = clampText(message, UTILITY_MESSAGE_LIMIT);
    const normalizedContext = clampText(context, UTILITY_CONTEXT_LIMIT);

    if (!original) {
      sendRequestError(req, res, 400, 'message is required', 'ai_invalid_input');
      return;
    }

    const raw = await aiService.complete(
      [
        {
          role: 'system',
          content:
            'You fix grammar and spelling while preserving meaning and style. Return ONLY JSON object: {"corrected":"...","changes":["..."]}.',
        },
        {
          role: 'user',
          content: `Context: ${normalizedContext || 'none'}\nMessage: ${original}`,
        },
      ],
      {
        maxTokens: 300,
        metadata: {
          requestId: getRequestId(req),
          route: 'fix-grammar',
          userId,
        },
        reasoningEffort: 'none',
        temperature: 0.2,
        timeoutMs: UTILITY_TIMEOUT_MS,
      }
    );

    const parsed = extractJsonObject(raw);
    const corrected =
      typeof parsed?.corrected === 'string' && parsed.corrected.trim()
        ? parsed.corrected.trim()
        : original;
    const changes = Array.isArray(parsed?.changes)
      ? parsed.changes.filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [];

    res.json({
      original,
      corrected,
      changes,
    });
  } catch (error) {
    sendAIError(req, res, error);
  }
};

export const changeTone = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { context, message, tone } = req.body as {
      context?: string;
      message?: string;
      tone?: string;
    };

    const original = clampText(message, UTILITY_MESSAGE_LIMIT);
    const normalizedContext = clampText(context, UTILITY_CONTEXT_LIMIT);
    const selectedTone = clampText(tone, 60) || DEFAULT_TONE;

    if (!original) {
      sendRequestError(req, res, 400, 'message is required', 'ai_invalid_input');
      return;
    }

    const transformed = await aiService.complete(
      [
        {
          role: 'system',
          content:
            'Rewrite text in requested tone while preserving intent and key facts. Return ONLY rewritten text.',
        },
        {
          role: 'user',
          content: [
            `Target tone: ${selectedTone}`,
            `Context: ${normalizedContext || 'none'}`,
            `Original message: ${original}`,
          ].join('\n'),
        },
      ],
      {
        maxTokens: 260,
        metadata: {
          requestId: getRequestId(req),
          route: 'change-tone',
          userId,
        },
        reasoningEffort: 'none',
        temperature: 0.5,
        timeoutMs: UTILITY_TIMEOUT_MS,
      }
    );

    res.json({
      original,
      transformed: transformed || original,
      tone: selectedTone,
    });
  } catch (error) {
    sendAIError(req, res, error);
  }
};

export const translateMessage = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { message, targetLanguage } = req.body as {
      message?: string;
      targetLanguage?: string;
    };

    const original = clampText(message, UTILITY_MESSAGE_LIMIT);
    const language = clampText(targetLanguage, 60) || 'English';

    if (!original) {
      sendRequestError(req, res, 400, 'message is required', 'ai_invalid_input');
      return;
    }

    const translated = await aiService.complete(
      [
        {
          role: 'system',
          content: 'Translate the user message accurately. Return ONLY translated text.',
        },
        {
          role: 'user',
          content: `Target language: ${language}\nText: ${original}`,
        },
      ],
      {
        maxTokens: 260,
        metadata: {
          requestId: getRequestId(req),
          route: 'translate',
          userId,
        },
        reasoningEffort: 'none',
        temperature: 0.2,
        timeoutMs: UTILITY_TIMEOUT_MS,
      }
    );

    res.json({
      original,
      translated: translated || original,
      targetLanguage: language,
    });
  } catch (error) {
    sendAIError(req, res, error);
  }
};

export const expandMessage = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureAuthenticatedUserId(req, res);
  if (!userId) return;

  try {
    const { context, message, style } = req.body as {
      context?: string;
      message?: string;
      style?: string;
    };

    const original = clampText(message, UTILITY_MESSAGE_LIMIT);
    const normalizedContext = clampText(context, UTILITY_CONTEXT_LIMIT);
    const normalizedStyle = clampText(style, 120) || 'concise and warm';

    if (!original) {
      sendRequestError(req, res, 400, 'message is required', 'ai_invalid_input');
      return;
    }

    const expanded = await aiService.complete(
      [
        {
          role: 'system',
          content:
            'Expand short user drafts into polished messages while preserving intent. Return ONLY expanded text.',
        },
        {
          role: 'user',
          content: [
            `Preferred style: ${normalizedStyle}`,
            `Context: ${normalizedContext || 'none'}`,
            `Original draft: ${original}`,
          ].join('\n'),
        },
      ],
      {
        maxTokens: 320,
        metadata: {
          requestId: getRequestId(req),
          route: 'expand',
          userId,
        },
        reasoningEffort: 'none',
        temperature: 0.6,
        timeoutMs: UTILITY_TIMEOUT_MS,
      }
    );

    res.json({
      original,
      expanded: expanded || original,
    });
  } catch (error) {
    sendAIError(req, res, error);
  }
};
