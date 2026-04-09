import { AgentActionRecord } from './types';

const DESTRUCTIVE_PATTERNS = [
  /\b(delete|erase|destroy)\b.*\b(post|group|message|conversation|chat|connection)\b/i,
  /\b(remove)\b.*\b(connection|message|conversation|group|post)\b/i,
  /\b(billing|payment|pay|purchase|refund|subscription)\b/i,
  /\b(ban|moderate|suspend)\b/i,
];

export function evaluateAgentUserInputSafety(inputText: string): {
  allowed: boolean;
  refusalMessage?: string;
  suggestedActions: AgentActionRecord[];
} {
  const normalized = inputText.trim();

  if (!normalized) {
    return {
      allowed: false,
      refusalMessage: 'Tell me what you want to do in Vormex, and I’ll take it from there.',
      suggestedActions: [],
    };
  }

  const matchesBlockedIntent = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized));
  if (!matchesBlockedIntent) {
    return {
      allowed: true,
      suggestedActions: [],
    };
  }

  return {
    allowed: false,
    refusalMessage:
      'I can help with discovery, messaging, connections, groups, notifications, and growth guidance, but I will not handle destructive, moderation, or billing actions in phase 1.',
    suggestedActions: [
      {
        type: 'safety_refusal',
        toolName: 'safety_policy',
        status: 'blocked',
        title: 'Blocked phase-1 action',
        summary: 'Destructive, moderation, and billing actions are intentionally disabled.',
        payload: {
          blockedCategory: 'destructive_or_billing',
        },
      },
    ],
  };
}

