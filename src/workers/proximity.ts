import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { Worker, type Job } from 'bullmq';
import { proximityRedis } from '../infrastructure/proximity/redis-client';
import { getProximityQueue, proximityQueueNames } from '../infrastructure/proximity/queues';
import { pairPartition, PROXIMITY_DIRTY_PARTITIONS, PROXIMITY_PUBLIC_TTL_SECONDS, proximityKeys } from '../infrastructure/proximity/redis-keys';
import { accumulateHeartbeatEncounter, persistEncounterDelta } from '../services/proximity-encounter.service';
import { generateProximitySummary } from '../services/proximity-summary.service';
import type { AccumulateHeartbeatJob, EncounterDelta } from '../types/proximity.types';
import { prisma } from '../config/prisma';
import { removeUserProximityPresence } from '../services/proximity-privacy.service';
import { getProximityFeatureFlags } from '../services/proximity-feature-flags.service';
import { proximityAccumulatorGauge } from '../infrastructure/metrics/registry';

const workers: Worker[] = [];

async function cleanupStaleGeoMemberships(): Promise<number> {
  if (!proximityRedis) return 0;
  let cursor = '0'; let scannedPages = 0; let removed = 0;
  const staleBefore = Date.now() - PROXIMITY_PUBLIC_TTL_SECONDS * 1_000;
  do {
    const [nextCursor, lastSeenKeys] = await proximityRedis.sscan(proximityKeys.shards, cursor, 'COUNT', 50);
    cursor = nextCursor; scannedPages += 1;
    for (const lastSeenKey of lastSeenKeys) {
      const shard = lastSeenKey.slice('proximity:v1:lastSeen:'.length);
      const staleUserIds = await proximityRedis.zrangebyscore(lastSeenKey, '-inf', staleBefore, 'LIMIT', 0, 500);
      if (staleUserIds.length > 0) {
        const presenceValues = await proximityRedis.mget(...staleUserIds.map((id) => proximityKeys.presence(id)));
        const pipeline = proximityRedis.pipeline();
        staleUserIds.forEach((id, index) => {
          let keep = false;
          const raw = presenceValues[index];
          if (raw) {
            try {
              const presence = JSON.parse(raw) as { shard?: string; serverSeenAtMs?: number; mode?: string };
              keep = presence.shard === shard && Number(presence.serverSeenAtMs || 0) > staleBefore;
            } catch { /* malformed presence is expiring and cannot keep GEO visibility */ }
          }
          if (keep) return;
          pipeline.zrem(proximityKeys.geo('event', shard), id);
          pipeline.zrem(proximityKeys.geo('public', shard), id);
          for (let cohort = 0; cohort < 8; cohort += 1) {
            pipeline.zrem(proximityKeys.geoCohort('event', shard, cohort), id);
            pipeline.zrem(proximityKeys.geoCohort('public', shard, cohort), id);
          }
          pipeline.zrem(lastSeenKey, id); removed += 1;
        });
        await pipeline.exec();
      }
      if (await proximityRedis.zcard(lastSeenKey) === 0) await proximityRedis.srem(proximityKeys.shards, lastSeenKey);
    }
  } while (cursor !== '0' && scannedPages < 20);
  return removed;
}

async function flushPartition(partition: number): Promise<number> {
  if (!proximityRedis || !getProximityFeatureFlags().persistence) return 0;
  const queue = getProximityQueue(proximityQueueNames.persistence); let claimed = 0;
  const highWater = Number(process.env.PROXIMITY_PERSISTENCE_QUEUE_HIGH_WATER || 5_000);
  if (await queue.getWaitingCount() >= highWater) return 0;
  for (let i = 0; i < 100; i += 1) {
    if (claimed > 0 && claimed % 25 === 0 && await queue.getWaitingCount() >= highWater) break;
    const popped = await proximityRedis.zpopmin(proximityKeys.dirty(partition), 1); if (!popped.length) break;
    const hash = popped[0];
    const flushId = randomUUID();
    const lockAcquired = await proximityRedis.set(proximityKeys.flushClaim(hash), flushId, 'EX', 86_400, 'NX');
    if (!lockAcquired) { await proximityRedis.zadd(proximityKeys.dirty(partition), Date.now(), hash); continue; }
    const data = await proximityRedis.hgetall(proximityKeys.accumulator(hash));
    if (!data.lowerUserId || Number(data.observationCount || 0) < 2) {
      await proximityRedis.del(proximityKeys.flushClaim(hash));
      continue;
    }
    const duration = Number(data.durationSeconds || 0) - Number(data.persistedDurationSeconds || 0);
    const samples = Number(data.sampleCount || 0) - Number(data.persistedSampleCount || 0);
    const encounters = Number(data.encounterCount || 1) - Number(data.persistedEncounterCount || 0);
    if (duration <= 0 && samples <= 0 && encounters <= 0) {
      await proximityRedis.del(proximityKeys.flushClaim(hash));
      continue;
    }
    const delta: EncounterDelta = { version: 1, flushId, lowerUserId: data.lowerUserId,
      higherUserId: data.higherUserId, firstSeenAt: new Date(Number(data.firstSeenAtMs)).toISOString(),
      lastSeenAt: new Date(Number(data.lastSeenAtMs)).toISOString(), durationSeconds: Math.max(0, duration), sampleCount: Math.max(0, samples),
      minimumDistanceM: Number(data.minimumDistanceM), encounterIncrement: Math.max(0, encounters) };
    await proximityRedis.set(proximityKeys.flush(flushId), JSON.stringify({ hash, delta, durationTarget: data.durationSeconds,
      sampleTarget: data.sampleCount, encounterTarget: data.encounterCount || '1' }), 'EX', 86_400);
    try { await queue.add('proximity-persist-flush', delta, { jobId: flushId, attempts: 8,
      backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 } }); claimed += 1; }
    catch (error) {
      await proximityRedis.del(proximityKeys.flushClaim(hash));
      await proximityRedis.zadd(proximityKeys.dirty(partition), Date.now(), hash);
      throw error;
    }
  }
  proximityAccumulatorGauge.set({ partition: String(partition) }, await proximityRedis.zcard(proximityKeys.dirty(partition)));
  return claimed;
}

export async function startProximityWorkers(): Promise<void> {
  if (!proximityRedis) return;
  workers.push(new Worker(proximityQueueNames.accumulation, async (job: Job<AccumulateHeartbeatJob>) => {
    if (job.data.version !== 1) throw new Error('Unsupported proximity job version');
    return accumulateHeartbeatEncounter(job.data.userId, job.data.candidateUserIds);
  }, { connection: proximityRedis, concurrency: Number(process.env.PROXIMITY_ACCUMULATION_CONCURRENCY || 8) }));
  workers.push(new Worker(proximityQueueNames.persistence, async (job: Job<EncounterDelta>) => {
    await persistEncounterDelta(job.data);
    const snapshot = await proximityRedis.get(proximityKeys.flush(job.data.flushId));
    if (snapshot) {
      const parsed = JSON.parse(snapshot);
      await proximityRedis.eval(`
        if redis.call('EXISTS', KEYS[1]) == 1 then
          redis.call('HSET', KEYS[1], 'persistedDurationSeconds', ARGV[1], 'persistedSampleCount', ARGV[2], 'persistedEncounterCount', ARGV[3])
        end
        redis.call('DEL', KEYS[2], KEYS[3])
        return 1
      `, 3, proximityKeys.accumulator(parsed.hash), proximityKeys.flush(job.data.flushId), proximityKeys.flushClaim(parsed.hash),
      parsed.durationTarget, parsed.sampleTarget, parsed.encounterTarget);
    }
  }, { connection: proximityRedis, concurrency: Number(process.env.PROXIMITY_PERSISTENCE_CONCURRENCY || 2) }));
  workers.push(new Worker(proximityQueueNames.maintenance, async (job) => {
    if (job.name === 'proximity-flush-dirty-partition') return flushPartition(Number(job.data.partition));
    if (job.name === 'proximity-expire-sessions') {
      const expired = await prisma.$transaction(async (tx) => {
        const claimed = await tx.$queryRaw<Array<{ id: string; userId: string }>>(Prisma.sql`
          SELECT "id", "userId"
          FROM "proximity_sessions"
          WHERE "status" = 'active' AND "expiresAt" <= NOW()
          ORDER BY "expiresAt" ASC
          LIMIT 500
          FOR UPDATE SKIP LOCKED
        `);
        if (claimed.length > 0) {
          await tx.proximity_sessions.updateMany({ where: { id: { in: claimed.map((session) => session.id) }, status: 'active' },
            data: { status: 'expired', endedAt: new Date(), endReason: 'server_timeout' } });
        }
        return claimed;
      });
      for (const session of expired) {
        await removeUserProximityPresence(session.userId);
        if (getProximityFeatureFlags().summaryNotifications) {
          await getProximityQueue(proximityQueueNames.summary).add('proximity-generate-summary', { sessionId: session.id },
            { jobId: `summary-${session.id}`, delay: 120_000 }).catch(() => undefined);
        }
      }
      return expired.length;
    }
    if (job.name === 'proximity-cleanup-geo') return cleanupStaleGeoMemberships();
    if (job.name === 'proximity-cleanup') {
      const now = new Date(); await prisma.proximity_encounter_pairs.deleteMany({ where: { expiresAt: { lte: now } } });
      await prisma.proximity_encounter_flush_receipts.deleteMany({ where: { processedAt: { lt: new Date(Date.now() - 8 * 86_400_000) } } });
      return true;
    }
    return null;
  }, { connection: proximityRedis, concurrency: 1 }));
  workers.push(new Worker(proximityQueueNames.summary, async (job) => generateProximitySummary(String(job.data.sessionId)), { connection: proximityRedis, concurrency: 2 }));
  for (const worker of workers) worker.on('failed', async (job, error) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      if (job.queueName === proximityQueueNames.persistence) {
        const snapshot = await proximityRedis.get(proximityKeys.flush(String(job.id)));
        if (snapshot) {
          const parsed = JSON.parse(snapshot) as { hash: string };
          await proximityRedis.del(proximityKeys.flushClaim(parsed.hash));
        }
      }
      await getProximityQueue(proximityQueueNames.deadLetter).add('failed-proximity-job',
        { queue: job.queueName, name: job.name, jobId: job.id, message: error.message }, { jobId: `dead-${job.queueName}-${job.id}` }).catch(() => undefined);
    }
  });
}

export async function stopProximityWorkers(): Promise<void> { await Promise.allSettled(workers.map((worker) => worker.close())); workers.length = 0; }
export { cleanupStaleGeoMemberships, flushPartition };
