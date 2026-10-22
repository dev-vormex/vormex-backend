import { AgentUiIntent, AgentActionRecord, AgentToolResult, AgentToolExecutionContext } from "../../types";
import { getAgentToolPolicy, evaluateToolExecutionPolicy } from "../../services/action-policy.service";
import { safetyErrorResponse } from "../../../safety/services/trust-safety.service";

export function actionRecord(params: {
  type: string;
  toolName: string;
  status: 'executed' | 'suggested' | 'blocked';
  title: string;
  summary: string;
  entityId?: string | null;
  entityType?: string | null;
  uiIntents?: AgentUiIntent[];
  payload?: Record<string, unknown>;
  riskLevel?: AgentActionRecord['riskLevel'];
  autonomyMode?: AgentActionRecord['autonomyMode'];
}): AgentActionRecord {
  const toolPolicy = getAgentToolPolicy(params.toolName);
  return {
    type: params.type,
    toolName: params.toolName,
    status: params.status,
    title: params.title,
    summary: params.summary,
    entityId: params.entityId || null,
    entityType: params.entityType || null,
    uiIntents: params.uiIntents || [],
    payload: params.payload || null,
    riskLevel: params.riskLevel || toolPolicy.riskLevel,
    autonomyMode: params.autonomyMode,
  };
}

export /**
 * Maps a SafetyActionError (block, banned/suspended, trust-tier cooldown) onto the
 * same blocked-tool shape the rest of this file uses. Returns null for any other
 * error so callers can rethrow it.
 */
function safetyToolFailure(
  err: unknown,
  params: {
    toolName: string;
    type: string;
    title: string;
    entityId?: string | null;
    entityType?: string | null;
  }
): AgentToolResult | null {
  const mapped = safetyErrorResponse(err);
  if (!mapped) return null;
  return {
    summary: mapped.body.error,
    output: {
      status: 'blocked',
      reason: mapped.body.code,
      retryable: mapped.body.retryable,
      ...(mapped.body.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: mapped.body.retryAfterSeconds }
        : {}),
    },
    blockedAction: actionRecord({
      type: params.type,
      toolName: params.toolName,
      status: 'blocked',
      title: params.title,
      summary: mapped.body.error,
      entityId: params.entityId,
      entityType: params.entityType,
    }),
  };
}

export function switchTabIntent(tab: string): AgentUiIntent {
  return {
    type: 'switch_tab',
    tab,
  };
}

export function openProfileIntent(userId: string): AgentUiIntent {
  return {
    type: 'open_profile',
    userId,
  };
}

export function openChatIntent(params: { userId?: string; conversationId?: string }): AgentUiIntent {
  return {
    type: 'open_chat',
    userId: params.userId,
    conversationId: params.conversationId,
  };
}

export function openGroupIntent(groupId: string): AgentUiIntent {
  return {
    type: 'open_group',
    groupId,
  };
}

export function openGrowthIntent(note?: string): AgentUiIntent {
  return {
    type: 'open_growth_task',
    label: note || 'Open Growth Hub',
  };
}

export function showInlineResultsIntent(payload: Record<string, unknown>): AgentUiIntent {
  return {
    type: 'show_inline_results',
    payload,
  };
}

export function maybeGateAction(
  toolName: string,
  ctx: AgentToolExecutionContext,
  params: {
    type: string;
    title: string;
    summary: string;
    entityId?: string | null;
    entityType?: string | null;
    uiIntents?: AgentUiIntent[];
    payload?: Record<string, unknown>;
  }
): AgentToolResult | null {
  const policyDecision = evaluateToolExecutionPolicy(toolName, ctx);
  const effectiveAutonomyMode =
    ctx.effectiveAutonomyMode ||
    ctx.autonomyMode ||
    (ctx.allowAutonomousActions ? 'power' : 'approval');

  if (policyDecision.canExecute) {
    return null;
  }

  if (!policyDecision.shouldCreateApproval) {
    const blockedAction = actionRecord({
      type: params.type,
      toolName,
      status: 'blocked',
      title: params.title,
      summary: `${params.summary} This action is blocked by Vormex safety policy.`,
      entityId: params.entityId,
      entityType: params.entityType,
      uiIntents: params.uiIntents,
      payload: params.payload,
      riskLevel: policyDecision.policy.riskLevel,
      autonomyMode: effectiveAutonomyMode,
    });

    return {
      summary: blockedAction.summary,
      output: {
        status: 'blocked',
        reason: policyDecision.reason,
        riskLevel: policyDecision.policy.riskLevel,
        autonomyMode: effectiveAutonomyMode,
        uiIntents: params.uiIntents || [],
      },
      blockedAction,
      uiIntents: params.uiIntents || [],
    };
  }

  const suggestedAction = actionRecord({
    type: params.type,
    toolName,
    status: 'suggested',
    title: params.title,
    summary: params.summary,
    entityId: params.entityId,
    entityType: params.entityType,
    uiIntents: params.uiIntents,
    payload: params.payload,
    riskLevel: policyDecision.policy.riskLevel,
    autonomyMode: effectiveAutonomyMode,
  });

  return {
    summary:
      policyDecision.policy.riskLevel === 'approval_required'
        ? `${params.summary} This action always needs your approval first.`
        : `${params.summary} I saved it for approval because power mode is unavailable or off.`,
    output: {
      status: 'approval_required',
      reason: policyDecision.reason,
      suggestion: params.summary,
      riskLevel: policyDecision.policy.riskLevel,
      autonomyMode: effectiveAutonomyMode,
      powerModeEligible: Boolean(ctx.powerModeEligible),
      uiIntents: params.uiIntents || [],
    },
    suggestedAction,
    uiIntents: params.uiIntents || [],
  };
}
