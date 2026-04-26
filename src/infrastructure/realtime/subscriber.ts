import type { Server } from 'socket.io';
import { redisSub } from '../redis/client';
import { REALTIME_CHANNEL, type RealtimeEnvelope } from './channels';
import { emitRealtimeEnvelopeToServer } from './emitter';
import { logger } from '../../lib/logger';

let subscribed = false;

export async function initializeRealtimeSubscriptions(io: Server): Promise<void> {
  if (!redisSub || subscribed) {
    return;
  }

  await redisSub.subscribe(REALTIME_CHANNEL);
  redisSub.on('message', (channel, message) => {
    if (channel !== REALTIME_CHANNEL) {
      return;
    }

    try {
      const envelope = JSON.parse(message) as RealtimeEnvelope;
      emitRealtimeEnvelopeToServer(io, envelope);
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
