import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';

export interface AgentGoalRecord {
  id: string;
  userId: string;
  goal: string;
  category: string | null;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

const REQUIRED_TABLES = ['user_goals'];

class AgentGoalsService {
  private readonly fallbackStore = new Map<string, Map<string, AgentGoalRecord>>();
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
    logger.warn({ event: 'agent.goals.memory_mode', reason, ...details });
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
        const foundTables = new Set(rows.map((row) => row.table_name));
        const missingTables = REQUIRED_TABLES.filter((table) => !foundTables.has(table));
        if (missingTables.length > 0) {
          this.enableMemoryMode('missing_tables', { missingTables });
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

  private getFallbackStore(userId: string): Map<string, AgentGoalRecord> {
    if (!this.fallbackStore.has(userId)) {
      this.fallbackStore.set(userId, new Map());
    }
    return this.fallbackStore.get(userId)!;
  }

  async getGoals(userId: string): Promise<AgentGoalRecord[]> {
    if ((await this.resolveStorageMode()) === 'memory') {
      return Array.from(this.getFallbackStore(userId).values()).sort((a, b) => {
        if (b.priority !== a.priority) {
          return b.priority - a.priority;
        }
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
    }

    try {
      const goals = await prisma.user_goals.findMany({
        where: { userId },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      });

      return goals.map((goal) => ({
        id: goal.id,
        userId: goal.userId,
        goal: goal.goal,
        category: goal.category,
        priority: goal.priority,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      }));
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
        return Array.from(this.getFallbackStore(userId).values()).sort((a, b) => {
          if (b.priority !== a.priority) {
            return b.priority - a.priority;
          }
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
      }
      throw error;
    }
  }

  async createGoal(params: {
    userId: string;
    goal: string;
    category?: string | null;
    priority?: number;
  }): Promise<AgentGoalRecord> {
    const goalRecord: AgentGoalRecord = {
      id: randomUUID(),
      userId: params.userId,
      goal: params.goal.trim(),
      category: params.category?.trim() || null,
      priority: Number.isFinite(params.priority) ? Number(params.priority) : 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if ((await this.resolveStorageMode()) === 'memory') {
      this.getFallbackStore(params.userId).set(goalRecord.id, goalRecord);
      return goalRecord;
    }

    try {
      const created = await prisma.user_goals.create({
        data: {
          userId: goalRecord.userId,
          goal: goalRecord.goal,
          category: goalRecord.category,
          priority: goalRecord.priority,
        },
      });

      return {
        id: created.id,
        userId: created.userId,
        goal: created.goal,
        category: created.category,
        priority: created.priority,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
        this.getFallbackStore(params.userId).set(goalRecord.id, goalRecord);
        return goalRecord;
      }
      throw error;
    }
  }

  async deleteGoal(userId: string, goalId: string): Promise<boolean> {
    if ((await this.resolveStorageMode()) === 'memory') {
      return this.getFallbackStore(userId).delete(goalId);
    }

    try {
      const deleted = await prisma.user_goals.deleteMany({
        where: {
          id: goalId,
          userId,
        },
      });
      return deleted.count > 0;
    } catch (error) {
      if (this.isStorageUnavailableError(error)) {
        this.enableMemoryMode('missing_tables_runtime', { code: (error as any).code });
        return this.getFallbackStore(userId).delete(goalId);
      }
      throw error;
    }
  }
}

export const agentGoalsService = new AgentGoalsService();
