import type { Server } from 'socket.io';
import { redisSub } from '../redis/client';
import { REALTIME_CHANNEL, type RealtimeEnvelope } from './channels';
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
      if (envelope.broadcast) {
        io.emit(envelope.event, envelope.payload);
      }
      for (const room of envelope.rooms || []) {
        io.to(room).emit(envelope.event, envelope.payload);
      }
      for (const userId of envelope.users || []) {
        io.to(`user:${userId}`).emit(envelope.event, envelope.payload);
      }
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
