import 'dotenv/config';
import { disconnectPrisma } from './config/prisma';
import { closeProximityQueues } from './infrastructure/proximity/queues';
import { closeProximityRedis, connectProximityRedis } from './infrastructure/proximity/redis-client';
import { logger } from './lib/logger';
import { startProximityWorkers, stopProximityWorkers } from './workers/proximity';

async function bootstrap() {
  if (!await connectProximityRedis()) throw new Error('Dedicated proximity Redis is unavailable');
  await startProximityWorkers();
  logger.info({ event: 'proximity.worker.started' });
}
async function shutdown(signal: string) {
  logger.info({ event: 'proximity.worker.stopping', signal });
  await stopProximityWorkers(); await closeProximityQueues(); await closeProximityRedis(); await disconnectPrisma(); process.exit(0);
}
void bootstrap().catch((error) => { logger.error({ event: 'proximity.worker.failed', message: error.message }); void shutdown('bootstrap_failure'); });
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
