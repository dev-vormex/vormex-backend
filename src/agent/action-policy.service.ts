import type {
  AgentActionRiskLevel,
  AgentAutonomyMode,
  AgentSessionSummary,
  AgentToolExecutionContext,
} from './types';

export interface AgentAutonomyPolicy {
  requestedAutonomyMode: AgentAutonomyMode;
  effectiveAutonomyMode: AgentAutonomyMode;
  powerModeEligible: boolean;
  isPremium: boolean;
  allowAutonomousActions: boolean;
}

export interface AgentToolPolicy {
  riskLevel: AgentActionRiskLevel;
  requiresApproval: boolean;
  blocked: boolean;
  reason: string;
}

const SAFE_READ_TOOLS = new Set([
  'people_search',
  'matching_find_like_minded_peers',
  'groups_discover',
  'profile_get_me',
  'profile_get_user',
  'growth_get_snapshot',
  'notifications_get_summary',
  'ui_navigate',
]);

const POWER_LOW_RISK_WRITE_TOOLS = new Set([
  'connections_send_request',
  'chat_open_conversation',
  'groups_join',
  'notifications_mark_all_read',
]);

const ALWAYS_APPROVAL_TOOLS = new Set([
  'chat_send_message',
  'connections_accept_request',
  'posts_create_text',
  'profile_update_summary',
]);

const ALWAYS_BLOCKED_TOOLS = new Set([
  'admin_delete_user',
  'billing_update_subscription',
  'moderation_action',
]);

export function normalizeAgentAutonomyMode(
  value: unknown,
  fallback: AgentAutonomyMode = 'approval'
): AgentAutonomyMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'power' || normalized === 'auto' || normalized === 'autonomous') {
    return 'power';
  }
  if (normalized === 'approval' || normalized === 'manual' || normalized === 'safe') {
    return 'approval';
  }
  return fallback;
}

export function requestedAutonomyFromPayload(params: {
  autonomyMode?: unknown;
  allowAutonomousActions?: unknown;
  fallback?: AgentAutonomyMode;
}): AgentAutonomyMode {
  if (params.autonomyMode !== undefined && params.autonomyMode !== null) {
    return normalizeAgentAutonomyMode(params.autonomyMode, params.fallback || 'approval');
  }
  if (typeof params.allowAutonomousActions === 'boolean') {
    return params.allowAutonomousActions ? 'power' : 'approval';
  }
  return params.fallback || 'approval';
}

export function resolveAgentAutonomyPolicy(params: {
  requestedAutonomyMode?: unknown;
  allowAutonomousActions?: unknown;
  fallbackMode?: AgentAutonomyMode;
  isPremium?: boolean;
}): AgentAutonomyPolicy {
  const requestedAutonomyMode = requestedAutonomyFromPayload({
    autonomyMode: params.requestedAutonomyMode,
    allowAutonomousActions: params.allowAutonomousActions,
    fallback: params.fallbackMode || 'approval',
  });
  const isPremium = Boolean(params.isPremium);
  const powerModeEligible = isPremium;
  const effectiveAutonomyMode =
    requestedAutonomyMode === 'power' && powerModeEligible ? 'power' : 'approval';

  return {
    requestedAutonomyMode,
    effectiveAutonomyMode,
    powerModeEligible,
    isPremium,
    allowAutonomousActions: effectiveAutonomyMode === 'power',
  };
}

export function applyAutonomyPolicyToSession(
  session: AgentSessionSummary,
  policy: AgentAutonomyPolicy
): AgentSessionSummary {
  return {
    ...session,
    allowAutonomousActions: policy.allowAutonomousActions,
    requestedAutonomyMode: policy.requestedAutonomyMode,
    effectiveAutonomyMode: policy.effectiveAutonomyMode,
    powerModeEligible: policy.powerModeEligible,
    isPremium: policy.isPremium,
  };
}

export function getAgentToolPolicy(toolName: string): AgentToolPolicy {
  if (ALWAYS_BLOCKED_TOOLS.has(toolName)) {
    return {
      riskLevel: 'blocked',
      requiresApproval: false,
      blocked: true,
      reason: 'tool_blocked_by_policy',
    };
  }
  if (SAFE_READ_TOOLS.has(toolName)) {
    return {
      riskLevel: 'safe_read',
      requiresApproval: false,
      blocked: false,
      reason: 'safe_read',
    };
  }
  if (POWER_LOW_RISK_WRITE_TOOLS.has(toolName)) {
    return {
      riskLevel: 'low_risk_write',
      requiresApproval: true,
      blocked: false,
      reason: 'low_risk_write',
    };
  }
  if (ALWAYS_APPROVAL_TOOLS.has(toolName)) {
    return {
      riskLevel: 'approval_required',
      requiresApproval: true,
      blocked: false,
      reason: 'approval_required',
    };
  }
  return {
    riskLevel: 'approval_required',
    requiresApproval: true,
    blocked: false,
    reason: 'unknown_write_requires_approval',
  };
}

export function evaluateToolExecutionPolicy(
  toolName: string,
  ctx: AgentToolExecutionContext
): {
  canExecute: boolean;
  shouldCreateApproval: boolean;
  policy: AgentToolPolicy;
  reason: string;
} {
  const policy = getAgentToolPolicy(toolName);
  const effectiveMode =
    ctx.effectiveAutonomyMode ||
    ctx.autonomyMode ||
    (ctx.allowAutonomousActions ? 'power' : 'approval');

  if (policy.blocked) {
    return {
      canExecute: false,
      shouldCreateApproval: false,
      policy,
      reason: policy.reason,
    };
  }

  if (ctx.approvedAction?.toolName === toolName) {
    return {
      canExecute: true,
      shouldCreateApproval: false,
      policy,
      reason: 'approved_action',
    };
  }

  if (!policy.requiresApproval) {
    return {
      canExecute: true,
      shouldCreateApproval: false,
      policy,
      reason: policy.reason,
    };
  }

  if (
    policy.riskLevel === 'low_risk_write' &&
    effectiveMode === 'power' &&
    ctx.powerModeEligible === true
  ) {
    return {
      canExecute: true,
      shouldCreateApproval: false,
      policy,
      reason: 'premium_power_low_risk_write',
    };
  }

  return {
    canExecute: false,
    shouldCreateApproval: true,
    policy,
    reason:
      policy.riskLevel === 'low_risk_write'
        ? 'power_mode_required_for_auto_write'
        : 'approval_required',
  };
}
