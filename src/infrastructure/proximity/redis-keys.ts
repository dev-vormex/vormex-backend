import { createHash } from 'crypto';
import type { ProximityMode } from '../../types/proximity.types';

export const PROXIMITY_EVENT_TTL_SECONDS = 360;
export const PROXIMITY_PUBLIC_TTL_SECONDS = 600;
export const PROXIMITY_IDEMPOTENCY_TTL_SECONDS = 600;
export const PROXIMITY_FLUSH_TTL_SECONDS = 86_400;
export const PROXIMITY_LIVE_SNAPSHOT_TTL_SECONDS = 90;
export const PROXIMITY_DIRTY_PARTITIONS = 32;

export const proximityKeys = {
  geo: (mode: ProximityMode, shard: string) => `proximity:v1:geo:${mode}:${shard}`,
  geoCohort: (mode: ProximityMode, shard: string, cohort: number) => `proximity:v1:geo:${mode}:${shard}:c:${cohort}`,
  presence: (userId: string) => `proximity:v1:presence:${userId}`,
  lastSeen: (shard: string) => `proximity:v1:lastSeen:${shard}`,
  session: (sessionId: string) => `proximity:v1:session:${sessionId}`,
  sample: (sessionId: string, sampleId: string) => `proximity:v1:sample:${sessionId}:${sampleId}`,
  response: (sessionId: string, generation: number, sequence: number) => `proximity:v1:heartbeat-response:${sessionId}:${generation}:${sequence}`,
  accumulator: (pairHash: string) => `proximity:v1:acc:${pairHash}`,
  observation: (pairHash: string, observationHash: string) => `proximity:v1:pair-observation:${pairHash}:${observationHash}`,
  dirty: (partition: number) => `proximity:v1:dirty:${partition}`,
  flush: (flushId: string) => `proximity:v1:flush:${flushId}`,
  flushClaim: (pairHash: string) => `proximity:v1:flush-claim:${pairHash}`,
  liveSnapshot: (viewerSession: string, queryHash: string) => `proximity:v1:live-snapshot:${viewerSession}:${queryHash}`,
  shards: 'proximity:v1:shards',
  cleanupUser: (userId: string) => `proximity:v1:cleanup:user:${userId}`,
};

export function canonicalPair(a: string, b: string): [string, string] {
  if (a === b) throw new Error('Users cannot encounter themselves');
  return a.localeCompare(b, 'en') < 0 ? [a, b] : [b, a];
}

export function pairHash(a: string, b: string): string {
  return createHash('sha256').update(canonicalPair(a, b).join(':')).digest('hex').slice(0, 32);
}

export function pairPartition(hash: string): number {
  return Number.parseInt(hash.slice(0, 8), 16) % PROXIMITY_DIRTY_PARTITIONS;
}
