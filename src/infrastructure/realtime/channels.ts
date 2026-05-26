import { isRedisEnabled, redisPub } from '../redis/client';

export const REALTIME_CHANNEL = 'vormex:realtime:events';

export interface RealtimeEnvelope {
  event: string;
  payload: Record<string, unknown>;
  rooms?: string[];
  users?: string[];
  broadcast?: boolean;
}

export async function publishRealtimeEnvelope(envelope: RealtimeEnvelope): Promise<void> {
  if (!isRedisEnabled() || !redisPub) {
    return;
  }

  await redisPub.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
}
