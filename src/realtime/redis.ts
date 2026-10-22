import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { logger } from '../infrastructure/logging/logger';
import { connectRedisClients, isRedisEnabled, redisPub, redisSub } from '../infrastructure/redis/client';
import { initializeRealtimeSubscriptions } from '../infrastructure/realtime/subscriber';

function shouldStartApiRedis(): boolean {
  const mode = (process.env.API_REDIS_MODE || 'auto').toLowerCase();
  if (['1', 'true', 'yes', 'enabled'].includes(mode)) {
    return true;
  }

  if (['0', 'false', 'no', 'disabled'].includes(mode)) {
    return false;
  }

  const redisUrl = process.env.CRITICAL_REDIS_URL || process.env.REDIS_URL || '';
  return process.env.NODE_ENV === 'production' || !/upstash\.io/i.test(redisUrl);
}

export function initializeApiRedis(io: SocketIOServer): Promise<void> {
  return shouldStartApiRedis()
    ? connectRedisClients().then(async () => {
        if (isRedisEnabled() && redisPub && redisSub) {
          io.adapter(createAdapter(redisPub, redisSub));
          await initializeRealtimeSubscriptions(io);
        }
      })
    : Promise.resolve().then(() => {
        logger.warn({
          event: 'redis.api.skipped',
          reason: 'remote_upstash_in_development',
          message: 'API Redis realtime infrastructure skipped. Set API_REDIS_MODE=true to enable it.',
        });
      });
}
