import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth.types';
import { getRequestId } from '../lib/logger';
import { agentSessionService } from '../agent/session.service';
import { agentOrchestratorService } from '../agent/orchestrator.service';
import { pendingActionsService } from '../agent/pending-actions.service';
import { agentGoalsService } from '../agent/goals.service';
import { emitAgentEvent, serializeAgentAction, serializeGoal, serializePendingAction } from '../agent/socket-events';
import { AIServiceError } from '../services/ai.service';

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function ensureUserId(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.user?.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return String(req.user.userId);
}

function sendAgentAIError(
  req: AuthenticatedRequest,
  res: Response,
  error: unknown,
  fallbackMessage: string
): boolean {
  if (!(error instanceof AIServiceError)) {
    return false;
  }

  if (typeof error.retryAfterSeconds === 'number') {
    res.setHeader('retry-after', String(error.retryAfterSeconds));
  }

  res.status(error.statusCode).json({
    error: error.userMessage || fallbackMessage,
    code: error.code,
    requestId: getRequestId(req),
    ...(typeof error.retryAfterSeconds === 'number' && {
      retryAfterSeconds: error.retryAfterSeconds,
    }),
  });
  return true;
}

export const createOrResumeSession = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const session = await agentSessionService.createOrResumeSession(userId, {
      sessionId: req.body?.sessionId,
      mode: req.body?.mode,
      surface: req.body?.surface,
      allowAutonomousActions: parseBoolean(req.body?.allowAutonomousActions, true),
      metadata: parseObject(req.body?.metadata),
    });

    res.status(200).json({
      sessionId: session.sessionId,
      mode: session.mode,
      sessionState: session,
    });
  } catch (error) {
    console.error('createOrResumeSession error:', error);
    res.status(500).json({ error: 'Failed to create agent session' });
  }
};

export const runAgentTurn = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const sessionId = String(req.params.sessionId || '');
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const inputText = String(req.body?.inputText || '').trim();
    if (!inputText) {
      res.status(400).json({ error: 'inputText is required' });
      return;
    }

    const response = await agentOrchestratorService.runTurn(
      userId,
      sessionId,
      {
        inputText,
        surface: req.body?.surface,
        surfaceContext: parseObject(req.body?.surfaceContext),
        allowAutonomousActions: parseBoolean(req.body?.allowAutonomousActions, true),
      },
      getRequestId(req)
    );

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent session not found') {
      res.status(404).json({ error: 'Agent session not found' });
      return;
    }
    if (sendAgentAIError(req, res, error, 'Agent AI is temporarily unavailable right now.')) {
      return;
    }
    console.error('runAgentTurn error:', error);
    res.status(500).json({ error: 'Failed to run agent turn' });
  }
};

export const runAgentVoiceTurn = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const sessionId = String(req.params.sessionId || '');
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    if (!req.file?.buffer) {
      res.status(400).json({ error: 'audio file is required' });
      return;
    }

    const response = await agentOrchestratorService.runVoiceTurn({
      userId,
      sessionId,
      audioBuffer: req.file.buffer,
      fileName: req.file.originalname || 'agent-audio.m4a',
      mimeType: req.file.mimetype || 'audio/mp4',
      synthesizeAudio: parseBoolean(req.body?.synthesizeAudio, true),
      requestId: getRequestId(req),
      turn: {
        inputText: '',
        surface: req.body?.surface,
        surfaceContext: parseObject(req.body?.surfaceContext),
        allowAutonomousActions: parseBoolean(req.body?.allowAutonomousActions, true),
      },
    });

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent session not found') {
      res.status(404).json({ error: 'Agent session not found' });
      return;
    }
    if (sendAgentAIError(req, res, error, 'Agent voice is temporarily unavailable right now.')) {
      return;
    }
    console.error('runAgentVoiceTurn error:', error);
    res.status(500).json({ error: 'Failed to run agent voice turn' });
  }
};

// GET /api/agent/pending-actions
export const getPendingActions = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const actions = await pendingActionsService.getPending(userId);
    res.json({ actions: actions.map(serializePendingAction) });
  } catch (error) {
    console.error('getPendingActions error:', error);
    res.status(500).json({ error: 'Failed to get pending actions' });
  }
};

// POST /api/agent/approve/:actionId
export const approveAction = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const actionId = String(req.params.actionId || '');
    const result = await pendingActionsService.approve(actionId, userId);
    if (!result.success) {
      res.status(400).json({ error: result.error || 'Failed to approve action' });
      return;
    }
    const actions = await pendingActionsService.getPending(userId);
    emitAgentEvent(
      userId,
      'agent:pending_actions_changed',
      {
        actions: actions.map(serializePendingAction),
      },
      result.sessionId
    );
    res.json({
      success: true,
      assistantMessage: result.assistantMessage || 'Approved and executed the action.',
      executedAction: result.executedAction ? serializeAgentAction(result.executedAction) : null,
      uiIntents: result.uiIntents || [],
      pendingActions: actions.map(serializePendingAction),
    });
  } catch (error) {
    console.error('approveAction error:', error);
    res.status(500).json({ error: 'Failed to approve action' });
  }
};

// POST /api/agent/reject/:actionId
export const rejectAction = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const actionId = String(req.params.actionId || '');
    await pendingActionsService.reject(actionId, userId);
    const actions = await pendingActionsService.getPending(userId);
    emitAgentEvent(
      userId,
      'agent:pending_actions_changed',
      {
        actions: actions.map(serializePendingAction),
      },
      null
    );
    res.json({
      success: true,
      assistantMessage: 'Rejected the pending action.',
      pendingActions: actions.map(serializePendingAction),
    });
  } catch (error) {
    console.error('rejectAction error:', error);
    res.status(500).json({ error: 'Failed to reject action' });
  }
};

// GET /api/agent/goals
export const getAgentGoals = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const goals = await agentGoalsService.getGoals(userId);
    res.json({ goals: goals.map(serializeGoal) });
  } catch (error) {
    console.error('getAgentGoals error:', error);
    res.status(500).json({ error: 'Failed to get goals' });
  }
};

// POST /api/agent/goals
export const upsertAgentGoal = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const { goal, category, priority } = req.body as {
      goal?: string;
      category?: string;
      priority?: number;
    };
    if (!goal?.trim()) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }
    const created = await agentGoalsService.createGoal({
      userId,
      goal,
      category: category || null,
      priority,
    });
    const goals = await agentGoalsService.getGoals(userId);
    await agentSessionService.upsertUserPreferences(userId, {
      goals: goals.map((item) => item.goal),
    });
    emitAgentEvent(userId, 'agent:goals_changed', { goals: goals.map(serializeGoal) });

    res.status(200).json({
      goal: serializeGoal(created),
      goals: goals.map(serializeGoal),
    });
  } catch (error) {
    console.error('upsertAgentGoal error:', error);
    res.status(500).json({ error: 'Failed to create goal' });
  }
};

// DELETE /api/agent/goals/:goalId
export const deleteAgentGoal = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = ensureUserId(req, res);
  if (!userId) return;

  try {
    const goalId = String(req.params.goalId || '');
    const deleted = await agentGoalsService.deleteGoal(userId, goalId);
    const goals = await agentGoalsService.getGoals(userId);
    await agentSessionService.upsertUserPreferences(userId, {
      goals: goals.map((item) => item.goal),
    });
    emitAgentEvent(userId, 'agent:goals_changed', { goals: goals.map(serializeGoal) });
    res.json({
      success: deleted,
      goals: goals.map(serializeGoal),
    });
  } catch (error) {
    console.error('deleteAgentGoal error:', error);
    res.status(500).json({ error: 'Failed to delete goal' });
  }
};
