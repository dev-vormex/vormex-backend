





import OpenAI from "openai";
import { AgentSessionSummary } from "../../types";
import { AgentAutonomyPolicy, applyAutonomyPolicyToSession } from "../action-policy.service";

export function extractGeminiOutputText(response: any): string {
  if (typeof response?.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }

  const parts = Array.isArray(response?.candidates?.[0]?.content?.parts)
    ? response.candidates[0].content.parts
    : [];
  return parts
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

export { parseRetryAfterSeconds } from "../../../../infrastructure/http/retry-after.util";

export { positiveIntEnv as intEnv } from "../../../../config/env.util";

export function toGeminiFunctionDeclarations(toolDefinitions: any[]): any[] {
  return toolDefinitions
    .filter((tool) => tool?.type === 'function' && typeof tool.name === 'string')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters || {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
    }));
}

export { dedupeUiIntents } from "../../utils/conversation-state.util";

export { mergeGoals } from "../../utils/conversation-state.util";

export function buildSessionStateWithPolicy(
  session: AgentSessionSummary,
  policy: AgentAutonomyPolicy
): AgentSessionSummary {
  return applyAutonomyPolicyToSession(session, policy);
}

export function trimmedEnv(name: string): string {
  return String(process.env[name] || '').trim();
}

export function buildOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxRetries: 2,
    timeout: Number(process.env.AGENT_AI_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 45000),
  });
}

export { extractLikelyGoals } from "../../utils/conversation-state.util";

export { buildMemorySummary } from "../../utils/conversation-state.util";

export function compactFallbackQuery(inputText: string): string | null {
  const cleaned = inputText
    .replace(
      /\b(please|could you|can you|help|agent|vormex|show|find|search|open|get|me|my|for|with|the|a|an|to|in|on|at|from|some|people|person|users|user|profiles|profile|peers|peer)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return null;
  }

  const words = cleaned.split(' ').filter(Boolean).slice(0, 8);
  return words.length > 0 ? words.join(' ') : null;
}
