import 'dotenv/config';
import { disconnectPrisma } from './config/prisma';
import { closeQueues } from './infrastructure/queue/queues';
import { connectRedisClients, disconnectRedisClients } from './infrastructure/redis/client';
import { logger } from './lib/logger';
import { registerSchedulerJobs } from './scheduler/index';

let idleTimer: NodeJS.Timeout | null = null;

async function bootstrap(): Promise<void> {
  await connectRedisClients();
  const registered = await registerSchedulerJobs();

  logger.info({
    event: 'scheduler.bootstrap.complete',
    active: registered,
  });

  if (!registered) {
    idleTimer = setInterval(() => {
      logger.debug({
        event: 'scheduler.idle',
        reason: 'redis_unavailable',
      });
    }, 60_000);
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({
    event: 'scheduler.shutdown.start',
    signal,
  });

  if (idleTimer) {
    clearInterval(idleTimer);
  }
  await closeQueues();
  await disconnectRedisClients();
  await disconnectPrisma();
  process.exit(0);
}

void bootstrap().catch(async (error) => {
  logger.error({
    event: 'scheduler.bootstrap.failed',
    message: error instanceof Error ? error.message : String(error),
  });
  await shutdown('bootstrap_failure');
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
