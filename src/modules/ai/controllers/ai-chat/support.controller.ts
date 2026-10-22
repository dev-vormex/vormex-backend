import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getRequestId, getRequestLogger } from "../../../../infrastructure/logging/logger";
import { AIServiceError, ChatMessage, aiService } from "../../services/ai.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { getPremiumAccessSnapshot } from "../../../premium/services/premium-access.service";
import { prisma } from "../../../../config/prisma";

export const AI_BUSY_MESSAGE = 'AI is temporarily busy. Please try again shortly.';

export const FALLBACK_STARTERS = [
  "Hey, I saw the work you're doing and think there may be useful overlap with what I'm building. I'd love to trade ideas and see if we can help each other move faster.",
  "Hey, your profile made me think we might have a strong collaboration angle. I'd love to understand what you're working on and share anything useful from my side.",
  "Hey, I noticed a few things in your profile that connect with my interests. Would you be open to trading notes and exploring a small way to collaborate?",
];

export const FALLBACK_REVIVALS = [
  "Hey, it's been a while! How have things been going?",
  'Hi! Just wanted to check in. Any exciting updates on your end?',
  "Hope you're doing well! Would love to catch up.",
];

export const FALLBACK_REPLIES = ['Sounds great!', 'Thanks for sharing!', 'Let me think about that.', "I'd love to learn more."];

export const DEFAULT_TONE = 'friendly';

export const UTILITY_MESSAGE_LIMIT = 1000;

export const UTILITY_CONTEXT_LIMIT = 1500;

export const UTILITY_TIMEOUT_MS = 20_000;

export const CAREER_HISTORY_MAX_TURNS = 12;

export const CAREER_HISTORY_MESSAGE_LIMIT = 500;

export const CAREER_HISTORY_TOTAL_LIMIT = 8000;

export const CAREER_MESSAGE_LIMIT = 2000;

export const CAREER_TIMEOUT_MS = 35_000;

export const ASSISTANT_HISTORY_MAX_TURNS = 10;

export const ASSISTANT_HISTORY_MESSAGE_LIMIT = 500;

export const ASSISTANT_HISTORY_TOTAL_LIMIT = 6000;

export const ASSISTANT_MESSAGE_LIMIT = 2000;

export const ASSISTANT_TIMEOUT_MS = 35_000;

export const FREE_ASSISTANT_DAILY_LIMIT = Number(process.env.RATE_LIMIT_AI_ASSISTANT_FREE_USER_PER_DAY || 10);

export const ASSISTANT_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

export const aiUserSelect = {
  id: true,
  name: true,
  username: true,
  headline: true,
  bio: true,
  college: true,
  branch: true,
  degree: true,
  currentYear: true,
  location: true,
  interests: true,
  skills: {
    take: 5,
    select: {
      skill: {
        select: {
          name: true,
        },
      },
    },
  },
  experiences: {
    where: { isCurrent: true },
    orderBy: { startDate: 'desc' as const },
    take: 2,
    select: {
      title: true,
      company: true,
      skills: true,
    },
  },
};

export interface SuggestionRequestParams {
  fallback: string[];
  limit: number;
  route: string;
  systemPrompt: string;
  temperature?: number;
  userPrompt: string;
}

export interface AIUserProfile {
  bio?: string | null;
  branch?: string | null;
  college?: string | null;
  currentYear?: number | null;
  degree?: string | null;
  experiences?: { company: string; skills: string[]; title: string }[];
  headline?: string | null;
  id: string;
  interests?: string[];
  location?: string | null;
  name: string;
  skills?: { skill?: { name?: string | null } | null }[];
  username: string;
}

export interface CareerHistoryItem {
  content?: string;
  role?: string;
}

export interface AssistantHistoryItem {
  content?: string;
  role?: string;
}

export function sendAIError(
  req: AuthenticatedRequest,
  res: Response,
  error: unknown,
  fallbackMessage: string = AI_BUSY_MESSAGE
): void {
  const requestId = getRequestId(req);
  const log = getRequestLogger(req);

  if (error instanceof AIServiceError) {
    if (typeof error.retryAfterSeconds === 'number') {
      res.setHeader('retry-after', String(error.retryAfterSeconds));
    }

    res.status(error.statusCode).json({
      error: error.userMessage || fallbackMessage,
      code: error.code,
      requestId,
      ...(typeof error.retryAfterSeconds === 'number' && {
        retryAfterSeconds: error.retryAfterSeconds,
      }),
    });
    return;
  }

  const unexpectedError = error instanceof Error ? error : new Error(String(error));
  log.error({
    event: 'ai.request.failure',
    requestId,
    code: 'ai_internal_error',
    message: unexpectedError.message,
    stack: unexpectedError.stack,
  });

  res.status(500).json({
    error: fallbackMessage,
    code: 'ai_internal_error',
    requestId,
  });
}

export function sendRequestError(
  req: AuthenticatedRequest,
  res: Response,
  statusCode: number,
  message: string,
  code: string
): void {
  res.status(statusCode).json({
    error: message,
    code,
    requestId: getRequestId(req),
  });
}

export function ensureAuthenticatedUserId(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.user?.userId) {
    sendRequestError(req, res, 401, 'Unauthorized', 'unauthorized');
    return null;
  }

  return String(req.user.userId);
}

export function clampText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export function buildBoundedText(parts: string[], maxChars: number): string {
  let combined = '';

  for (const part of parts.map((item) => item.trim()).filter(Boolean)) {
    const separator = combined ? '\n\n' : '';
    const remaining = maxChars - combined.length - separator.length;

    if (remaining <= 0) {
      break;
    }

    const boundedPart = part.length > remaining ? part.slice(0, remaining) : part;
    combined += `${separator}${boundedPart}`;

    if (boundedPart.length < part.length) {
      break;
    }
  }

  return combined;
}

export function cleanListItems(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const item of items) {
    const normalized = item
      .replace(/^[-*\d.)\s]+/, '')
      .replace(/^"|"$/g, '')
      .trim();

    if (!normalized) continue;

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    cleaned.push(normalized);

    if (cleaned.length >= limit) {
      break;
    }
  }

  return cleaned;
}

export function extractJsonArray(text: string): string[] | null {
  const direct = text.trim();
  if (direct.startsWith('[') && direct.endsWith(']')) {
    try {
      const parsed = JSON.parse(direct);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string');
      }
    } catch {
      return null;
    }
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;

  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === 'string');
    }
  } catch {
    return null;
  }

  return null;
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const direct = text.trim();
  if (direct.startsWith('{') && direct.endsWith('}')) {
    try {
      const parsed = JSON.parse(direct);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;

  try {
    const parsed = JSON.parse(objectMatch[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function normalizeConversationContent(content: string, contentType: string): string {
  const normalized = clampText(content, 220);
  if (normalized) {
    return normalized;
  }

  return contentType === 'text' ? '[empty message]' : `[${contentType} message]`;
}

export function formatUserContext(label: string, user: AIUserProfile | null): string {
  if (!user) {
    return `${label}: unavailable`;
  }

  const profileParts = [
    `${label}:`,
    `Name: ${user.name} (@${user.username})`,
    user.headline ? `Headline: ${user.headline}` : '',
    user.bio ? `Bio: ${user.bio}` : '',
    user.degree || user.college
      ? `Education: ${[user.degree, user.college, user.branch].filter(Boolean).join(', ')}`
      : '',
    typeof user.currentYear === 'number' ? `Current year: ${user.currentYear}` : '',
    user.location ? `Location: ${user.location}` : '',
    user.interests?.length ? `Interests: ${user.interests.slice(0, 5).join(', ')}` : '',
    user.skills?.length
      ? `Skills: ${user.skills
          .map((entry) => entry.skill?.name)
          .filter((skillName): skillName is string => Boolean(skillName))
          .slice(0, 5)
          .join(', ')}`
      : '',
    user.experiences?.length
      ? `Current work: ${user.experiences
          .map((experience) => {
            const details = [experience.title, experience.company].filter(Boolean).join(' at ');
            const skillSummary = experience.skills?.length
              ? ` (${experience.skills.slice(0, 3).join(', ')})`
              : '';
            return `${details}${skillSummary}`;
          })
          .join('; ')}`
      : '',
  ].filter(Boolean);

  return profileParts.join('\n');
}

export function buildConversationTranscript(
  conversation: any,
  currentUserId: string,
  otherUserName: string
): string {
  const transcriptLines = (conversation.messages || [])
    .slice()
    .reverse()
    .map((message: any) => {
      const speaker = message.senderId === currentUserId ? 'You' : otherUserName;
      return `${speaker}: ${normalizeConversationContent(message.content, message.contentType)}`;
    });

  return transcriptLines.join('\n');
}

export function normalizeCareerHistory(history: CareerHistoryItem[]): ChatMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const trimmedHistory = history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .slice(-CAREER_HISTORY_MAX_TURNS);

  const collected: ChatMessage[] = [];
  let totalChars = 0;

  for (let index = trimmedHistory.length - 1; index >= 0; index -= 1) {
    const entry = trimmedHistory[index];
    const content = clampText(entry.content, CAREER_HISTORY_MESSAGE_LIMIT);

    if (!content) {
      continue;
    }

    if (totalChars + content.length > CAREER_HISTORY_TOTAL_LIMIT) {
      break;
    }

    collected.push({
      role: entry.role as 'user' | 'assistant',
      content,
    });
    totalChars += content.length;
  }

  return collected.reverse();
}

export function normalizeAssistantHistory(history: AssistantHistoryItem[]): ChatMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const trimmedHistory = history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .slice(-ASSISTANT_HISTORY_MAX_TURNS);

  const collected: ChatMessage[] = [];
  let totalChars = 0;

  for (let index = trimmedHistory.length - 1; index >= 0; index -= 1) {
    const entry = trimmedHistory[index];
    const content = clampText(entry.content, ASSISTANT_HISTORY_MESSAGE_LIMIT);

    if (!content) {
      continue;
    }

    if (totalChars + content.length > ASSISTANT_HISTORY_TOTAL_LIMIT) {
      break;
    }

    collected.push({
      role: entry.role as 'user' | 'assistant',
      content,
    });
    totalChars += content.length;
  }

  return collected.reverse();
}

export function getFreeAssistantDailyLimit(): number {
  return Number.isFinite(FREE_ASSISTANT_DAILY_LIMIT) && FREE_ASSISTANT_DAILY_LIMIT > 0
    ? Math.round(FREE_ASSISTANT_DAILY_LIMIT)
    : 10;
}

export async function consumeFreeAssistantQuota(userId: string) {
  const limit = getFreeAssistantDailyLimit();
  const result = await cacheService.incrementFixedWindow(
    `ai:assistant:free-daily:${userId}`,
    ASSISTANT_DAILY_WINDOW_SECONDS
  );

  return {
    allowed: result.count <= limit,
    count: result.count,
    limit,
    remaining: Math.max(0, limit - result.count),
    resetAt: result.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)),
  };
}

export function getAITierLabel(snapshot: Awaited<ReturnType<typeof getPremiumAccessSnapshot>>): string {
  if (snapshot.user.isAdmin) return 'admin';
  if (snapshot.isCreatorPro) return 'creator_pro';
  if (snapshot.isPremium) return 'premium';
  return 'free';
}

export async function getUserProfile(userId: string): Promise<AIUserProfile | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: aiUserSelect,
  }) as Promise<AIUserProfile | null>;
}

export async function getConversationContext(userId: string, conversationId: string, take: number) {
  return prisma.conversations.findFirst({
    where: {
      id: conversationId,
      OR: [{ participant1Id: userId }, { participant2Id: userId }],
    },
    include: {
      users_conversations_participant1IdTousers: {
        select: {
          id: true,
          name: true,
          username: true,
        },
      },
      users_conversations_participant2IdTousers: {
        select: {
          id: true,
          name: true,
          username: true,
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          content: true,
          contentType: true,
          createdAt: true,
          senderId: true,
        },
      },
    },
  });
}

export async function requestSuggestions(
  req: AuthenticatedRequest,
  params: SuggestionRequestParams
): Promise<string[]> {
  const userId = req.user?.userId ? String(req.user.userId) : undefined;

  const raw = await aiService.complete(
    [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
    {
      maxTokens: 260,
      metadata: {
        requestId: getRequestId(req),
        route: params.route,
        userId,
      },
      reasoningEffort: 'none',
      temperature: params.temperature ?? 0.7,
      timeoutMs: UTILITY_TIMEOUT_MS,
    }
  );

  const parsedArray = extractJsonArray(raw);
  if (parsedArray && parsedArray.length > 0) {
    const cleaned = cleanListItems(parsedArray, params.limit);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }

  const cleanedLines = cleanListItems(raw.split('\n'), params.limit);
  if (cleanedLines.length > 0) {
    return cleanedLines;
  }

  return params.fallback.slice(0, params.limit);
}
