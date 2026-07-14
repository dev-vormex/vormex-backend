import 'dotenv/config';
import { closeProximityQueues } from './infrastructure/proximity/queues';
import { closeProximityRedis, connectProximityRedis } from './infrastructure/proximity/redis-client';
import { logger } from './lib/logger';
import { registerProximitySchedulerJobs } from './scheduler/proximity';

async function bootstrap() { if (!await connectProximityRedis()) throw new Error('Dedicated proximity Redis is unavailable'); await registerProximitySchedulerJobs(); logger.info({ event: 'proximity.scheduler.started' }); }
async function shutdown(signal: string) { logger.info({ event: 'proximity.scheduler.stopping', signal }); await closeProximityQueues(); await closeProximityRedis(); process.exit(0); }
void bootstrap().catch((error) => { logger.error({ event: 'proximity.scheduler.failed', message: error.message }); void shutdown('bootstrap_failure'); });
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
