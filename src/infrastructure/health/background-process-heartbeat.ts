import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isCriticalRedisEnabled, redisCommand } from '../redis/client';
import { logger } from '../../lib/logger';

export type BackgroundProcessRole = 'worker' | 'scheduler';
export type BackgroundProcessStatus = 'healthy' | 'missing' | 'stale' | 'unavailable';

export interface BackgroundProcessHeartbeat {
  role: BackgroundProcessRole;
  instanceId: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
}

export interface BackgroundRoleHealth {
  status: BackgroundProcessStatus;
  ageMs?: number;
  instanceId?: string;
  lastSeenAt?: string;
}

export interface BackgroundProcessesHealth {
  required: boolean;
  healthy: boolean;
  roles: Record<BackgroundProcessRole, BackgroundRoleHealth>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HEARTBEAT_INTERVAL_MS = parsePositiveInt(
  process.env.BACKGROUND_HEARTBEAT_INTERVAL_MS,
  10_000
);
const HEARTBEAT_TTL_SECONDS = Math.max(
  10,
  parsePositiveInt(process.env.BACKGROUND_HEARTBEAT_TTL_SECONDS, 45)
);
const HEARTBEAT_STALE_AFTER_MS = parsePositiveInt(
  process.env.BACKGROUND_HEARTBEAT_STALE_AFTER_MS,
  30_000
);
const BACKGROUND_PROCESSES_REQUIRED =
  process.env.BACKGROUND_PROCESSES_REQUIRED === 'true';

function heartbeatKey(role: BackgroundProcessRole): string {
  return `vormex:health:background:${role}`;
}

function parseHeartbeat(raw: string | null): BackgroundProcessHeartbeat | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<BackgroundProcessHeartbeat>;
    if (
      (parsed.role !== 'worker' && parsed.role !== 'scheduler') ||
      typeof parsed.instanceId !== 'string' ||
      typeof parsed.lastSeenAt !== 'string'
    ) {
      return null;
    }
    return parsed as BackgroundProcessHeartbeat;
  } catch {
    return null;
  }
}

export function evaluateBackgroundHeartbeat(
  raw: string | null,
  role: BackgroundProcessRole,
  nowMs = Date.now()
): BackgroundRoleHealth {
  const heartbeat = parseHeartbeat(raw);
  if (!heartbeat || heartbeat.role !== role) {
    return { status: 'missing' };
  }

  const lastSeenMs = Date.parse(heartbeat.lastSeenAt);
  if (!Number.isFinite(lastSeenMs)) {
    return { status: 'missing' };
  }

  const ageMs = Math.max(0, nowMs - lastSeenMs);
  return {
    status: ageMs <= HEARTBEAT_STALE_AFTER_MS ? 'healthy' : 'stale',
    ageMs,
    instanceId: heartbeat.instanceId,
    lastSeenAt: heartbeat.lastSeenAt,
  };
}

export async function startBackgroundProcessHeartbeat(
  role: BackgroundProcessRole
): Promise<(() => Promise<void>) | null> {
  if (!isCriticalRedisEnabled() || !redisCommand) {
    return null;
  }

  const startedAt = new Date().toISOString();
  const instanceId =
    process.env.RENDER_INSTANCE_ID || `${os.hostname()}:${process.pid}:${randomUUID()}`;

  const publish = async (): Promise<void> => {
    const heartbeat: BackgroundProcessHeartbeat = {
      role,
      instanceId,
      pid: process.pid,
      startedAt,
      lastSeenAt: new Date().toISOString(),
    };
    await redisCommand.set(
      heartbeatKey(role),
      JSON.stringify(heartbeat),
      'EX',
      HEARTBEAT_TTL_SECONDS
    );
  };

  await publish();
  const timer = setInterval(() => {
    void publish().catch((error) => {
      logger.error({
        event: 'background.heartbeat.failed',
        role,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    // Do not delete a shared role key during rolling deploys. Its short TTL
    // safely removes a stopped instance without erasing a replacement's pulse.
  };
}

export async function getBackgroundProcessesHealth(): Promise<BackgroundProcessesHealth> {
  if (!isCriticalRedisEnabled() || !redisCommand) {
    const status: BackgroundProcessStatus = 'unavailable';
    return {
      required: BACKGROUND_PROCESSES_REQUIRED,
      healthy: !BACKGROUND_PROCESSES_REQUIRED,
      roles: {
        worker: { status },
        scheduler: { status },
      },
    };
  }

  const [workerRaw, schedulerRaw] = await redisCommand.mget(
    heartbeatKey('worker'),
    heartbeatKey('scheduler')
  );
  const roles = {
    worker: evaluateBackgroundHeartbeat(workerRaw, 'worker'),
    scheduler: evaluateBackgroundHeartbeat(schedulerRaw, 'scheduler'),
  };
  const bothHealthy =
    roles.worker.status === 'healthy' && roles.scheduler.status === 'healthy';

  return {
    required: BACKGROUND_PROCESSES_REQUIRED,
    healthy: !BACKGROUND_PROCESSES_REQUIRED || bothHealthy,
    roles,
  };
}
