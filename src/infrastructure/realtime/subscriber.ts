import type { Server } from 'socket.io';
import { isRedisEnabled, redisSub } from '../redis/client';
import { REALTIME_CHANNEL, type RealtimeEnvelope } from './channels';
import { emitRealtimeEnvelopeToServer } from './emitter';
import { logger } from '../../lib/logger';

let subscribed = false;

export async function initializeRealtimeSubscriptions(io: Server): Promise<void> {
  if (!isRedisEnabled() || !redisSub || subscribed) {
    return;
  }

  await redisSub.subscribe(REALTIME_CHANNEL);
  redisSub.on('message', (channel, message) => {
    if (channel !== REALTIME_CHANNEL) {
      return;
    }

    try {
      const envelope = JSON.parse(message) as RealtimeEnvelope;
      // Every instance receives this publish, so each one delivers to its own
      // sockets only. Re-emitting through the Redis adapter here would deliver
      // N copies per client (N = instance count).
      emitRealtimeEnvelopeToServer(io, envelope, { localOnly: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({
        event: 'realtime.subscriber.decode_failed',
        message: err.message,
      });
    }
  });

  subscribed = true;
}
