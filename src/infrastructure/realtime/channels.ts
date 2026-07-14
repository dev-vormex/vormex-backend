import { isRedisEnabled, redisCommand, redisPub } from '../redis/client';

export const REALTIME_CHANNEL = 'vormex:realtime:events';

export interface RealtimeEnvelope {
  event: string;
  payload: Record<string, unknown>;
  rooms?: string[];
  users?: string[];
  broadcast?: boolean;
  /**
   * Stable identity for exactly-once delivery. Envelopes that are emitted
   * immediately by the API and also replayed via the outbox must carry the
   * same key so the replay can be suppressed.
   */
  dedupeKey?: string;
}

const EMITTED_MARKER_PREFIX = 'vormex:realtime:emitted:';
const EMITTED_MARKER_TTL_MS = 120_000;

/**
 * Record that an envelope was already delivered by a live API instance, so the
 * outbox replay can skip it. Fire-and-forget; failures only mean a duplicate
 * emit, which clients de-dupe by message id.
 */
export function markEnvelopeEmitted(dedupeKey: string): void {
  if (!isRedisEnabled() || !redisPub || !dedupeKey) {
    return;
  }
  void redisPub
    .set(`${EMITTED_MARKER_PREFIX}${dedupeKey}`, '1', 'PX', EMITTED_MARKER_TTL_MS)
    .catch(() => undefined);
}

/**
 * Atomically claim the right to publish an envelope. Returns false when a live
 * instance already emitted it (or another worker claimed it first). When Redis
 * is unavailable the claim always succeeds — duplicates are preferable to
 * dropped events, and clients de-dupe by message id.
 */
export async function claimEnvelopePublish(dedupeKey: string): Promise<boolean> {
  if (!isRedisEnabled() || !redisCommand || !dedupeKey) {
    return true;
  }
  const result = await redisCommand.set(
    `${EMITTED_MARKER_PREFIX}${dedupeKey}`,
    '1',
    'PX',
    EMITTED_MARKER_TTL_MS,
    'NX'
  );
  return result === 'OK';
}

export async function publishRealtimeEnvelope(envelope: RealtimeEnvelope): Promise<void> {
  if (!isRedisEnabled() || !redisPub) {
    return;
  }

  await redisPub.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
}
