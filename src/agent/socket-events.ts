import {
  AgentActionRecord,
  AgentGoalSummary,
  AgentPendingActionSummary,
} from './types';
import type { PendingActionRecord } from './pending-actions.service';
import type { AgentGoalRecord } from './goals.service';
import { getIO } from '../sockets';

export function serializeAgentAction(action: AgentActionRecord): AgentActionRecord {
  return {
    ...action,
    pendingActionId: action.pendingActionId || null,
    entityId: action.entityId || null,
    entityType: action.entityType || null,
    uiIntents: action.uiIntents || [],
    payload: action.payload || null,
    riskLevel: action.riskLevel,
    autonomyMode: action.autonomyMode,
  };
}

export function serializePendingAction(action: PendingActionRecord): AgentPendingActionSummary {
  return {
    id: action.id,
    sessionId: action.sessionId,
    userId: action.userId,
    toolName: action.toolName,
    actionType: action.actionType,
    title: action.title,
    summary: action.summary,
    input: action.input || null,
    status: action.status,
    context: action.context || null,
    riskLevel:
      action.riskLevel ||
      ((action.context as Record<string, unknown> | null)?.riskLevel as any) ||
      null,
    autonomyMode:
      action.autonomyMode ||
      ((action.context as Record<string, unknown> | null)?.autonomyMode as any) ||
      null,
    createdAt: action.createdAt.toISOString(),
    expiresAt: action.expiresAt.toISOString(),
    resolvedAt: action.resolvedAt ? action.resolvedAt.toISOString() : null,
  };
}

export function serializeGoal(goal: AgentGoalRecord): AgentGoalSummary {
  return {
    id: goal.id,
    userId: goal.userId,
    goal: goal.goal,
    category: goal.category,
    priority: goal.priority,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

export function emitAgentEvent(
  userId: string,
  event: string,
  payload: Record<string, unknown>,
  sessionId?: string | null
): void {
  const io = getIO();
  if (!io) return;

  io.to(`user:${userId}`).emit(event, payload);
  if (sessionId) {
    io.to(`agent:session:${sessionId}`).emit(event, payload);
  }
}
