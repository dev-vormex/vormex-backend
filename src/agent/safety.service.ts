import { AgentActionRecord } from './types';
import { containsPromptInjection } from '../utils/input-security.util';

const DESTRUCTIVE_PATTERNS = [
  /\b(delete|erase|destroy)\b.*\b(posts?|groups?|messages?|conversations?|chats?|connections?)\b/i,
  /\b(remove)\b.*\b(connections?|messages?|conversations?|groups?|posts?)\b/i,
  /\b(billing|payment|pay|purchase|refund|subscription)\b/i,
  /\b(ban|moderate|suspend)\b/i,
];

const ILLEGAL_OR_HARMFUL_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  {
    category: 'credential_theft',
    pattern: /\b(steal|grab|dump|extract|phish|phishing|bypass|crack)\b.*\b(passwords?|otps?|tokens?|cookies?|sessions?|credentials?|accounts?)\b/i,
  },
  {
    category: 'malware_or_hacking',
    pattern: /\b(malware|ransomware|keylogger|botnet|ddos|exploit|backdoor|sql injection|xss|hack into|unauthorized access)\b/i,
  },
  {
    category: 'scam_or_fraud',
    pattern: /\b(fake|forge|impersonate|scam|fraud|carding|money mule|launder|laundering)\b/i,
  },
  {
    category: 'weapons_or_explosives',
    pattern: /\b(make|build|buy|sell|source|assemble)\b.*\b(bomb|explosive|gun|firearm|weapon|grenade|detonator)\b/i,
  },
  {
    category: 'illegal_drugs',
    pattern: /\b(buy|sell|source|traffic|ship|deliver)\b.*\b(cocaine|heroin|meth|mdma|lsd|illegal drugs|narcotics)\b/i,
  },
  {
    category: 'policy_bypass',
    pattern: /\b(ignore|disable|bypass|override)\b.*\b(safety|policy|guardrail|approval|restriction|illegal)\b/i,
  },
  {
    category: 'secrets_access',
    pattern: /\b(show|reveal|print|send|get|read)\b.*(\.env|environment variables|api key|secret|private key|database password)\b/i,
  },
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

  if (containsPromptInjection(normalized)) {
    return {
      allowed: false,
      refusalMessage:
        'I can help with Vormex tasks, but I cannot follow requests that try to override or reveal hidden instructions.',
      suggestedActions: [
        {
          type: 'safety_refusal',
          toolName: 'safety_policy',
          status: 'blocked',
          title: 'Blocked prompt-injection attempt',
          summary: 'Requests to override or reveal hidden instructions are rejected.',
          payload: {
            blockedCategory: 'prompt_injection',
          },
        },
      ],
    };
  }

  const matchesBlockedIntent = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(normalized));
  const illegalMatch = ILLEGAL_OR_HARMFUL_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  if (!matchesBlockedIntent && !illegalMatch) {
    return {
      allowed: true,
      suggestedActions: [],
    };
  }

  if (illegalMatch) {
    return {
      allowed: false,
      refusalMessage:
        'I can help with safe Vormex tasks, but I cannot help with illegal, harmful, credential, secret, or safety-bypass requests.',
      suggestedActions: [
        {
          type: 'safety_refusal',
          toolName: 'safety_policy',
          status: 'blocked',
          title: 'Blocked unsafe request',
          summary: 'Illegal, harmful, credential, secret, and safety-bypass requests are rejected.',
          payload: {
            blockedCategory: illegalMatch.category,
          },
          riskLevel: 'blocked',
          autonomyMode: 'approval',
        },
      ],
    };
  }

  return {
    allowed: false,
    refusalMessage:
      'I can help with discovery, messaging, connections, groups, notifications, and growth guidance, but I will not handle destructive, moderation, or billing actions.',
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
        riskLevel: 'blocked',
        autonomyMode: 'approval',
      },
    ],
  };
}
