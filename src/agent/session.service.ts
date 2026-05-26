import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';
import {
  AgentActionRecord,
  AgentSessionBootstrapRequest,
  AgentSessionSummary,
  AgentUiIntent,
} from './types';
import { redactAgentPayload } from './data-safety';

class AgentSessionService {
  private readonly requiredAgentTables = [
    'agent_sessions',
    'agent_messages',
    'agent_action_logs',
    'agent_user_preferences',
  ];
  private readonly fallbackSessions = new Map<string, any>();
  private readonly fallbackSessionIdsByUser = new Map<string, string>();
  private readonly fallbackPreferences = new Map<string, any>();
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

    if (this.hasLoggedMemoryMode) {
      return;
    }

    this.hasLoggedMemoryMode = true;
    logger.warn({
      event: 'agent.storage.memory_mode',
      reason,
      ...details,
    });
  }

  private async resolveStorageMode(): Promise<'database' | 'memory'> {
    if (this.storageMode !== 'unknown') {
      return this.storageMode;
    }

    if (this.storageModePromise) {
      return this.storageModePromise;
    }

    this.storageModePromise = (async () => {
      try {
        const rows = await prisma.$queryRaw<Array<{ table_name: string }>>(
          Prisma.sql`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN (${Prisma.join(this.requiredAgentTables)})
          `
        );
        const foundTables = new Set(rows.map((row) => row.table_name));
        const missingTables = this.requiredAgentTables.filter((table) => !foundTables.has(table));

        if (missingTables.length > 0) {
          this.enableMemoryMode('missing_agent_tables', {
            missingTables,
          });
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

  private getFallbackSessionByUser(userId: string): any | null {
    const sessionId = this.fallbackSessionIdsByUser.get(userId);
    if (!sessionId) return null;
    return this.fallbackSessions.get(sessionId) || null;
  }

  private createFallbackSession(params: {
    userId: string;
    surface: string;
    mode: string;
    allowAutonomousActions: boolean;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  }): any {
    const id = params.sessionId || randomUUID();
    const session = {
      id,
      userId: params.userId,
      status: 'active',
      mode: params.mode,
      currentSurface: params.surface,
      title: null,
      lastResponseId: null,
      memorySummary: null,
      allowAutonomousActions: params.allowAutonomousActions,
      metadata: params.metadata || null,
      lastActiveAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.fallbackSessions.set(id, session);
    this.fallbackSessionIdsByUser.set(params.userId, id);
    return session;
  }

  private createOrResumeFallbackSession(
    userId: string,
    payload: AgentSessionBootstrapRequest = {}
  ): AgentSessionSummary {
    const requestedSurface = payload.surface || 'global';
    const requestedMode = payload.mode || 'text';
    const requestedAllowAutonomous = payload.allowAutonomousActions ?? false;

    let session =
      (payload.sessionId ? this.fallbackSessions.get(payload.sessionId) : null) ||
      this.getFallbackSessionByUser(userId);

    if (!session) {
      session = this.createFallbackSession({
        userId,
        surface: requestedSurface,
        mode: requestedMode,
        allowAutonomousActions: requestedAllowAutonomous,
        metadata: payload.metadata,
        sessionId: payload.sessionId,
      });
    } else {
      session.currentSurface = requestedSurface;
      session.mode = requestedMode;
      session.allowAutonomousActions = requestedAllowAutonomous;
      session.metadata = payload.metadata || session.metadata || null;
      session.lastActiveAt = new Date();
      session.updatedAt = new Date();
      this.fallbackSessions.set(session.id, session);
      this.fallbackSessionIdsByUser.set(userId, session.id);
    }

    const existingPreference = this.fallbackPreferences.get(userId) || {};
    this.fallbackPreferences.set(userId, {
      ...existingPreference,
      userId,
      lastSessionId: session.id,
    });

    return this.mapSession(session);
  }

  private mapSession(session: any): AgentSessionSummary {
    return {
      sessionId: session.id,
      status: session.status,
      mode: session.mode,
      currentSurface: session.currentSurface,
      memorySummary: session.memorySummary,
      allowAutonomousActions: Boolean(session.allowAutonomousActions),
      lastResponseId: session.lastResponseId,
    };
  }

  async createOrResumeSession(
    userId: string,
    payload: AgentSessionBootstrapRequest = {}
  ): Promise<AgentSessionSummary> {
    if ((await this.resolveStorageMode()) === 'memory') {
      return this.createOrResumeFallbackSession(userId, payload);
    }

    const requestedSurface = payload.surface || 'global';
    const requestedMode = payload.mode || 'text';
    const requestedAllowAutonomous = payload.allowAutonomousActions ?? false;

    try {
      let session = null;
      if (payload.sessionId) {
        session = await prisma.agent_sessions.findFirst({
          where: {
            id: payload.sessionId,
            userId,
          },
        });
      }

      if (!session) {
        session = await prisma.agent_sessions.findFirst({
          where: {
            userId,
            status: 'active',
          },
          orderBy: {
            lastActiveAt: 'desc',
          },
        });
      }

      if (session) {
        const updated = await prisma.agent_sessions.update({
          where: { id: session.id },
          data: {
            currentSurface: requestedSurface,
            mode: requestedMode,
            allowAutonomousActions: requestedAllowAutonomous,
            metadata: (payload.metadata || session.metadata || undefined) as any,
            lastActiveAt: new Date(),
          },
        });

        await this.upsertUserPreferences(userId, {
          lastSessionId: updated.id,
        });

        return this.mapSession(updated);
      }

      const created = await prisma.agent_sessions.create({
        data: {
          userId,
          currentSurface: requestedSurface,
          mode: requestedMode,
          allowAutonomousActions: requestedAllowAutonomous,
          metadata: (payload.metadata || undefined) as any,
        },
      });

      await this.upsertUserPreferences(userId, {
        lastSessionId: created.id,
      });

      return this.mapSession(created);
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        return this.createOrResumeFallbackSession(userId, payload);
      }
      throw error;
    }
  }

  async getSessionForUser(sessionId: string, userId: string): Promise<any> {
    if ((await this.resolveStorageMode()) === 'memory') {
      const session = this.fallbackSessions.get(sessionId);
      return session?.userId === userId ? session : null;
    }

    try {
      return await prisma.agent_sessions.findFirst({
        where: {
          id: sessionId,
          userId,
        },
      });
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        const session = this.fallbackSessions.get(sessionId);
        return session?.userId === userId ? session : null;
      }
      throw error;
    }
  }

  async requireSession(sessionId: string, userId: string): Promise<any> {
    const session = await this.getSessionForUser(sessionId, userId);
    if (!session) {
      throw new Error('Agent session not found');
    }

    return session;
  }

  async appendMessage(params: {
    sessionId: string;
    userId: string;
    role: string;
    content: string;
    kind?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if ((await this.resolveStorageMode()) === 'memory') {
      const session = this.fallbackSessions.get(params.sessionId);
      if (session?.userId === params.userId) {
        session.lastActiveAt = new Date();
        session.updatedAt = new Date();
        this.fallbackSessions.set(session.id, session);
      }
      return;
    }

    try {
      await prisma.agent_messages.create({
        data: {
          sessionId: params.sessionId,
          userId: params.userId,
          role: params.role,
          kind: params.kind || 'message',
          content: params.content,
          metadata: (params.metadata || undefined) as any,
        },
      });
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        const session = this.fallbackSessions.get(params.sessionId);
        if (session?.userId === params.userId) {
          session.lastActiveAt = new Date();
          session.updatedAt = new Date();
          this.fallbackSessions.set(session.id, session);
        }
        return;
      }
      throw error;
    }
  }

  async logAction(params: {
    sessionId: string;
    userId: string;
    action: AgentActionRecord;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    uiIntents?: AgentUiIntent[];
  }): Promise<void> {
    if ((await this.resolveStorageMode()) === 'memory') {
      return;
    }

    try {
      await prisma.agent_action_logs.create({
        data: {
          sessionId: params.sessionId,
          userId: params.userId,
          toolName: params.action.toolName,
          status: params.action.status,
          summary: params.action.summary,
          input: (params.input ? redactAgentPayload(params.input) : undefined) as any,
          output: (params.output
            ? {
                ...(redactAgentPayload(params.output) as Record<string, unknown>),
                policy: {
                  riskLevel: params.action.riskLevel || null,
                  autonomyMode: params.action.autonomyMode || null,
                },
              }
            : undefined) as any,
          uiIntents: (params.uiIntents && params.uiIntents.length > 0 ? params.uiIntents : undefined) as any,
        },
      });
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        return;
      }
      throw error;
    }
  }

  async updateSession(
    sessionId: string,
    data: {
      currentSurface?: string;
      lastResponseId?: string | null;
      memorySummary?: string | null;
      metadata?: Record<string, unknown> | null;
      allowAutonomousActions?: boolean;
      title?: string | null;
    }
  ): Promise<AgentSessionSummary> {
    if ((await this.resolveStorageMode()) === 'memory') {
      const session = this.fallbackSessions.get(sessionId);
      if (!session) {
        throw new Error('Agent session not found');
      }
      session.currentSurface = data.currentSurface ?? session.currentSurface;
      session.lastResponseId = data.lastResponseId ?? session.lastResponseId;
      session.memorySummary = data.memorySummary ?? session.memorySummary;
      session.metadata = data.metadata !== undefined ? data.metadata : session.metadata;
      session.allowAutonomousActions =
        data.allowAutonomousActions ?? session.allowAutonomousActions;
      session.title = data.title ?? session.title;
      session.lastActiveAt = new Date();
      session.updatedAt = new Date();
      this.fallbackSessions.set(session.id, session);
      return this.mapSession(session);
    }

    try {
      const updated = await prisma.agent_sessions.update({
        where: { id: sessionId },
        data: {
          currentSurface: data.currentSurface,
          lastResponseId: data.lastResponseId,
          memorySummary: data.memorySummary,
          metadata: data.metadata as any,
          allowAutonomousActions: data.allowAutonomousActions,
          title: data.title,
          lastActiveAt: new Date(),
        },
      });

      return this.mapSession(updated);
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        const session = this.fallbackSessions.get(sessionId);
        if (!session) {
          throw error;
        }
        session.currentSurface = data.currentSurface ?? session.currentSurface;
        session.lastResponseId = data.lastResponseId ?? session.lastResponseId;
        session.memorySummary = data.memorySummary ?? session.memorySummary;
        session.metadata = data.metadata !== undefined ? data.metadata : session.metadata;
        session.allowAutonomousActions =
          data.allowAutonomousActions ?? session.allowAutonomousActions;
        session.title = data.title ?? session.title;
        session.lastActiveAt = new Date();
        session.updatedAt = new Date();
        this.fallbackSessions.set(session.id, session);
        return this.mapSession(session);
      }
      throw error;
    }
  }

  async getUserPreferences(userId: string): Promise<any> {
    if ((await this.resolveStorageMode()) === 'memory') {
      return this.fallbackPreferences.get(userId) || null;
    }

    try {
      return await prisma.agent_user_preferences.findUnique({
        where: {
          userId,
        },
      });
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        return this.fallbackPreferences.get(userId) || null;
      }
      throw error;
    }
  }

  async upsertUserPreferences(
    userId: string,
    data: {
      goals?: string[];
      preferredOutreachStyle?: string | null;
      memorySummary?: string | null;
      preferences?: Record<string, unknown>;
      lastSessionId?: string | null;
    }
  ): Promise<void> {
    if ((await this.resolveStorageMode()) === 'memory') {
      const existing = this.fallbackPreferences.get(userId) || {};
      this.fallbackPreferences.set(userId, {
        userId,
        goals: data.goals || existing.goals || [],
        preferredOutreachStyle:
          data.preferredOutreachStyle !== undefined
            ? data.preferredOutreachStyle
            : existing.preferredOutreachStyle || null,
        memorySummary:
          data.memorySummary !== undefined
            ? data.memorySummary
            : existing.memorySummary || null,
        preferences: data.preferences || existing.preferences || null,
        lastSessionId:
          data.lastSessionId !== undefined ? data.lastSessionId : existing.lastSessionId || null,
      });
      return;
    }

    try {
      const existing = await prisma.agent_user_preferences.findUnique({
        where: {
          userId,
        },
      });

      await prisma.agent_user_preferences.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          goals: data.goals || [],
          preferredOutreachStyle: data.preferredOutreachStyle || null,
          memorySummary: data.memorySummary || null,
          preferences: (data.preferences || undefined) as any,
          lastSessionId: data.lastSessionId || null,
        },
        update: {
          goals: data.goals || existing?.goals || [],
          preferredOutreachStyle:
            data.preferredOutreachStyle !== undefined
              ? data.preferredOutreachStyle
              : existing?.preferredOutreachStyle || null,
          memorySummary:
            data.memorySummary !== undefined ? data.memorySummary : existing?.memorySummary || null,
          preferences: (data.preferences || existing?.preferences || undefined) as any,
          lastSessionId:
            data.lastSessionId !== undefined ? data.lastSessionId : existing?.lastSessionId || null,
        },
      });
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_agent_tables_runtime', {
          code: error.code,
        });
        const existing = this.fallbackPreferences.get(userId) || {};
        this.fallbackPreferences.set(userId, {
          userId,
          goals: data.goals || existing.goals || [],
          preferredOutreachStyle:
            data.preferredOutreachStyle !== undefined
              ? data.preferredOutreachStyle
              : existing.preferredOutreachStyle || null,
          memorySummary:
            data.memorySummary !== undefined
              ? data.memorySummary
              : existing.memorySummary || null,
          preferences: data.preferences || existing.preferences || null,
          lastSessionId:
            data.lastSessionId !== undefined ? data.lastSessionId : existing.lastSessionId || null,
        });
        return;
      }
      throw error;
    }
  }
}

export const agentSessionService = new AgentSessionService();
