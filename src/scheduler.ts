import 'dotenv/config';
import { disconnectPrisma } from './config/prisma';
import { closeQueues } from './infrastructure/queue/queues';
import { connectRedisClients, disconnectRedisClients } from './infrastructure/redis/client';
import { logger } from './lib/logger';
import { registerSchedulerJobs } from './scheduler/index';

async function bootstrap(): Promise<void> {
  await connectRedisClients();
  await registerSchedulerJobs();

  logger.info({
    event: 'scheduler.bootstrap.complete',
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({
    event: 'scheduler.shutdown.start',
    signal,
  });

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
