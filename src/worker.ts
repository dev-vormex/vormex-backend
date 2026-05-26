import 'dotenv/config';
import { disconnectPrisma } from './config/prisma';
import { closeQueues } from './infrastructure/queue/queues';
import { connectRedisClients, disconnectRedisClients } from './infrastructure/redis/client';
import { logger } from './lib/logger';
import { startWorkers, stopWorkers } from './workers';

let idleTimer: NodeJS.Timeout | null = null;

async function bootstrap(): Promise<void> {
  await connectRedisClients();
  const started = await startWorkers();

  logger.info({
    event: 'worker.bootstrap.complete',
    active: started,
  });

  if (!started) {
    idleTimer = setInterval(() => {
      logger.debug({
        event: 'worker.idle',
        reason: 'redis_unavailable',
      });
    }, 60_000);
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({
    event: 'worker.shutdown.start',
    signal,
  });

  await stopWorkers();
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
    event: 'worker.bootstrap.failed',
    message: error instanceof Error ? error.message : String(error),
  });
  await shutdown('bootstrap_failure');
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
