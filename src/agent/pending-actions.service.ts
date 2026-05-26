import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';
import { executeAgentTool } from './tools';
import { agentSessionService } from './session.service';
import type { AgentActionRecord, AgentToolExecutionContext, AgentUiIntent } from './types';
import { emitAgentEvent, serializeAgentAction, serializePendingAction } from './socket-events';
import { describeNavigationPreview, resolveAgentSurfaceFromUiIntents } from './surface-utils';
import { getAgentToolPolicy } from './action-policy.service';

export interface PendingActionRecord {
  id: string;
  sessionId: string;
  userId: string;
  toolName: string;
  actionType: string;
  title: string;
  summary: string;
  input: Record<string, unknown> | null;
  status: string;
  context: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  riskLevel?: string | null;
  autonomyMode?: string | null;
}

export interface CreatePendingParams {
  sessionId: string;
  userId: string;
  toolName: string;
  actionType: string;
  title: string;
  summary: string;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface PendingActionApprovalResult {
  success: boolean;
  error?: string;
  assistantMessage?: string;
  executedAction?: AgentActionRecord | null;
  uiIntents?: AgentUiIntent[];
  sessionId?: string;
}

const PENDING_ACTION_TTL_HOURS = 24;
const REQUIRED_TABLES = ['agent_pending_actions'];

class PendingActionsService {
  private readonly fallbackStore = new Map<string, Map<string, PendingActionRecord>>();
  private storageMode: 'unknown' | 'database' | 'memory' = 'unknown';
  private storageModePromise: Promise<'database' | 'memory'> | null = null;
  private hasLoggedMemoryMode = false;

  private isStorageUnavailableError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2021' || error.code === 'P2022')
    );
  }

  private enableMemoryMode(reason: string, details?: Record<string, unknown>): void {
    this.storageMode = 'memory';
    if (this.hasLoggedMemoryMode) return;
    this.hasLoggedMemoryMode = true;
    logger.warn({ event: 'agent.pending_actions.memory_mode', reason, ...details });
  }

  private async resolveStorageMode(): Promise<'database' | 'memory'> {
    if (this.storageMode !== 'unknown') return this.storageMode;
    if (this.storageModePromise) return this.storageModePromise;

    this.storageModePromise = (async () => {
      try {
        const rows = await prisma.$queryRaw<Array<{ table_name: string }>>(
          Prisma.sql`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN (${Prisma.join(REQUIRED_TABLES)})
          `
        );
        const foundTables = new Set(rows.map((r) => r.table_name));
        const missing = REQUIRED_TABLES.filter((t) => !foundTables.has(t));
        if (missing.length > 0) {
          this.enableMemoryMode('missing_tables', { missingTables: missing });
        } else {
          this.storageMode = 'database';
        }
      } catch {
        this.storageMode = 'database';
      }
      return this.storageMode === 'unknown' ? 'database' : this.storageMode;
    })();

    try {
      return await this.storageModePromise;
    } finally {
      this.storageModePromise = null;
    }
  }

  private getFallbackStore(userId: string): Map<string, PendingActionRecord> {
    if (!this.fallbackStore.has(userId)) {
      this.fallbackStore.set(userId, new Map());
    }
    return this.fallbackStore.get(userId)!;
  }

  async createPending(params: CreatePendingParams): Promise<PendingActionRecord> {
    const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_HOURS * 60 * 60 * 1000);
    const record: PendingActionRecord = {
      id: crypto.randomUUID(),
      sessionId: params.sessionId,
      userId: params.userId,
      toolName: params.toolName,
      actionType: params.actionType,
      title: params.title,
      summary: params.summary,
      input: params.input ?? null,
      status: 'pending',
      context: params.context ?? null,
      createdAt: new Date(),
      expiresAt,
      resolvedAt: null,
    };

    if ((await this.resolveStorageMode()) === 'memory') {
      this.getFallbackStore(params.userId).set(record.id, record);
      emitAgentEvent(
        params.userId,
        'agent:pending_action_created',
        {
          action: serializePendingAction(record),
        },
        params.sessionId
      );
      return record;
    }

    try {
      const created = await prisma.agent_pending_actions.create({
        data: {
          sessionId: record.sessionId,
          userId: record.userId,
          toolName: record.toolName,
          actionType: record.actionType,
          title: record.title,
          summary: record.summary,
          input: record.input as any,
          status: record.status,
          context: record.context as any,
          expiresAt: record.expiresAt,
        },
      });
      const persisted = { ...record, id: created.id };
      emitAgentEvent(
        params.userId,
        'agent:pending_action_created',
        {
          action: serializePendingAction(persisted),
        },
        params.sessionId
      );
      return persisted;
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
        this.getFallbackStore(params.userId).set(record.id, record);
        emitAgentEvent(
          params.userId,
          'agent:pending_action_created',
          {
            action: serializePendingAction(record),
          },
          params.sessionId
        );
        return record;
      }
      throw error;
    }
  }

  async getPending(userId: string): Promise<PendingActionRecord[]> {
    if ((await this.resolveStorageMode()) === 'memory') {
      const store = this.getFallbackStore(userId);
      return Array.from(store.values()).filter(
        (a) => a.status === 'pending' && a.expiresAt > new Date()
      );
    }

    try {
      const actions = await prisma.agent_pending_actions.findMany({
        where: { userId, status: 'pending', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      return actions.map((a) => ({
        id: a.id,
        sessionId: a.sessionId,
        userId: a.userId,
        toolName: a.toolName,
        actionType: a.actionType,
        title: a.title,
        summary: a.summary,
        input: a.input as Record<string, unknown> | null,
        status: a.status,
        context: a.context as Record<string, unknown> | null,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        resolvedAt: a.resolvedAt,
      }));
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
        const store = this.getFallbackStore(userId);
        return Array.from(store.values()).filter(
          (a) => a.status === 'pending' && a.expiresAt > new Date()
        );
      }
      throw error;
    }
  }

  async approve(actionId: string, userId: string): Promise<PendingActionApprovalResult> {
    let action: PendingActionRecord | undefined;

    if ((await this.resolveStorageMode()) === 'memory') {
      action = this.getFallbackStore(userId).get(actionId);
    } else {
      try {
        const dbAction = await prisma.agent_pending_actions.findFirst({
          where: { id: actionId, userId, status: 'pending' },
        });
        if (dbAction) {
          action = {
            id: dbAction.id,
            sessionId: dbAction.sessionId,
            userId: dbAction.userId,
            toolName: dbAction.toolName,
            actionType: dbAction.actionType,
            title: dbAction.title,
            summary: dbAction.summary,
            input: dbAction.input as Record<string, unknown> | null,
            status: dbAction.status,
            context: dbAction.context as Record<string, unknown> | null,
            createdAt: dbAction.createdAt,
            expiresAt: dbAction.expiresAt,
            resolvedAt: dbAction.resolvedAt,
          };
        }
      } catch (error) {
        if (this.isStorageUnavailableError(error)) {
          this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
          action = this.getFallbackStore(userId).get(actionId);
        } else {
          throw error;
        }
      }
    }

    if (!action || action.status !== 'pending') {
      return { success: false, error: 'Pending action not found or already resolved.' };
    }

    if (action.expiresAt < new Date()) {
      await this.resolvePendingAction(actionId, userId, 'rejected');
      return { success: false, error: 'Pending action has expired.' };
    }

    try {
      const contextSurface =
        typeof (action.context as Record<string, unknown> | null)?.surface === 'string'
          ? String((action.context as Record<string, unknown>).surface)
          : 'global';
      const ctx: AgentToolExecutionContext = {
        userId: action.userId,
        sessionId: action.sessionId,
        surface: contextSurface,
        surfaceContext: (action.context ?? {}) as Record<string, unknown>,
        allowAutonomousActions: false,
        autonomyMode: 'approval',
        effectiveAutonomyMode: 'approval',
        requestedAutonomyMode: 'approval',
        powerModeEligible: false,
        isPremium: false,
        approvedAction: {
          actionId,
          toolName: action.toolName,
        },
      };
      const policy = getAgentToolPolicy(action.toolName);
      if (policy.blocked) {
        return { success: false, error: 'That action is blocked by Vormex safety policy.' };
      }

      const toolResult = await executeAgentTool(
        action.toolName,
        (action.input ?? {}) as Record<string, any>,
        ctx
      );

      const actionToLog =
        toolResult.executedAction || toolResult.suggestedAction || toolResult.blockedAction || null;

      if (actionToLog) {
        await agentSessionService.logAction({
          sessionId: action.sessionId,
          userId: action.userId,
          action: actionToLog,
          input: (action.input ?? {}) as Record<string, unknown>,
          output: toolResult.output,
          uiIntents: toolResult.uiIntents || [],
        });
      }

      await agentSessionService.appendMessage({
        sessionId: action.sessionId,
        userId: action.userId,
        role: 'assistant',
        content: toolResult.summary,
        metadata: {
          pendingActionId: actionId,
          approvalStatus: 'approved',
        },
      });

      await this.resolvePendingAction(actionId, userId, 'approved');
      const resolvedSurface = resolveAgentSurfaceFromUiIntents(ctx.surface, toolResult.uiIntents || []);
      await agentSessionService.updateSession(action.sessionId, {
        currentSurface: resolvedSurface,
      });
      emitAgentEvent(
        userId,
        'agent:approval_executed',
        {
          actionId,
          sessionId: action.sessionId,
          surface: resolvedSurface,
          assistantMessage: toolResult.summary,
          executedAction: actionToLog ? serializeAgentAction(actionToLog) : null,
          uiIntents: toolResult.uiIntents || [],
        },
        action.sessionId
      );
      if (toolResult.uiIntents?.length) {
        emitAgentEvent(
          userId,
          'agent:navigation_preview',
          {
            sessionId: action.sessionId,
            surface: resolvedSurface,
            message: describeNavigationPreview(toolResult.uiIntents),
          },
          action.sessionId
        );
      }

      return {
        success: true,
        assistantMessage: toolResult.summary,
        executedAction: actionToLog ? serializeAgentAction(actionToLog) : null,
        uiIntents: toolResult.uiIntents || [],
        sessionId: action.sessionId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Action execution failed: ${message}` };
    }
  }

  async reject(actionId: string, userId: string): Promise<{ success: boolean }> {
    await this.resolvePendingAction(actionId, userId, 'rejected');
    return { success: true };
  }

  private async resolvePendingAction(
    actionId: string,
    userId: string,
    status: 'approved' | 'rejected'
  ): Promise<void> {
    const resolvedAt = new Date();

    if ((await this.resolveStorageMode()) === 'memory') {
      const store = this.getFallbackStore(userId);
      const action = store.get(actionId);
      if (action) {
        action.status = status;
        action.resolvedAt = resolvedAt;
        store.set(actionId, action);
        emitAgentEvent(
          userId,
          'agent:pending_action_resolved',
          {
            actionId,
            sessionId: action.sessionId,
            status,
            resolvedAt: resolvedAt.toISOString(),
          },
          action.sessionId
        );
      }
      return;
    }

    try {
      await prisma.agent_pending_actions.updateMany({
        where: { id: actionId, userId },
        data: { status, resolvedAt },
      });
      emitAgentEvent(
        userId,
        'agent:pending_action_resolved',
        {
          actionId,
          status,
          resolvedAt: resolvedAt.toISOString(),
        },
        null
      );
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
        const store = this.getFallbackStore(userId);
        const action = store.get(actionId);
        if (action) {
          action.status = status;
          action.resolvedAt = resolvedAt;
          store.set(actionId, action);
          emitAgentEvent(
            userId,
            'agent:pending_action_resolved',
            {
              actionId,
              sessionId: action.sessionId,
              status,
              resolvedAt: resolvedAt.toISOString(),
            },
            action.sessionId
          );
        }
      }
    }
  }

  async cleanupExpired(): Promise<number> {
    if ((await this.resolveStorageMode()) === 'memory') {
      let count = 0;
      const now = new Date();
      for (const [, store] of this.fallbackStore.entries()) {
        for (const [id, action] of store.entries()) {
          if (action.status === 'pending' && action.expiresAt < now) {
            action.status = 'expired';
            count++;
          }
        }
      }
      return count;
    }

    try {
      const result = await prisma.agent_pending_actions.updateMany({
        where: { status: 'pending', expiresAt: { lt: new Date() } },
        data: { status: 'expired', resolvedAt: new Date() },
      });
      return result.count;
    } catch {
      return 0;
    }
  }
}

export const pendingActionsService = new PendingActionsService();
