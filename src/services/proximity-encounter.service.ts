import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { haversineM } from '../infrastructure/proximity/geo-shards';
import { proximityRedis } from '../infrastructure/proximity/redis-client';
import { canonicalPair, pairHash, pairPartition, proximityKeys } from '../infrastructure/proximity/redis-keys';
import type { EncounterDelta, ProximityPresence } from '../types/proximity.types';
import { getBlockedUserIds } from './trust-safety.service';

const ACCUMULATE_SCRIPT = `
local currentAt = tonumber(ARGV[1])
local existingFirstAt = tonumber(redis.call('HGET', KEYS[1], 'firstSeenAtMs') or '0')
if existingFirstAt > 0 and currentAt - existingFirstAt >= 43200000 then
  local duration = tonumber(redis.call('HGET', KEYS[1], 'durationSeconds') or '0')
  local samples = tonumber(redis.call('HGET', KEYS[1], 'sampleCount') or '0')
  local encounters = tonumber(redis.call('HGET', KEYS[1], 'encounterCount') or '1')
  local persistedDuration = tonumber(redis.call('HGET', KEYS[1], 'persistedDurationSeconds') or '0')
  local persistedSamples = tonumber(redis.call('HGET', KEYS[1], 'persistedSampleCount') or '0')
  local persistedEncounters = tonumber(redis.call('HGET', KEYS[1], 'persistedEncounterCount') or '0')
  if persistedDuration >= duration and persistedSamples >= samples and persistedEncounters >= encounters then
    redis.call('DEL', KEYS[1])
  else
    redis.call('ZADD', KEYS[3], ARGV[1], ARGV[5])
    return {'max_age_unflushed'}
  end
end
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', 600) == false then return {'duplicate'} end
local count = tonumber(redis.call('HGET', KEYS[1], 'observationCount') or '0')
local previousAt = tonumber(redis.call('HGET', KEYS[1], 'lastObservationAtMs') or '0')
if previousAt > 0 and currentAt <= previousAt then return {'out_of_order'} end
local continuityCount = tonumber(redis.call('HGET', KEYS[1], 'continuityCount') or '0')
local encounterCount = tonumber(redis.call('HGET', KEYS[1], 'encounterCount') or '1')
local increment = 0
if previousAt > 0 and currentAt - previousAt <= 300000 then
  increment = math.min(120, math.floor((currentAt - previousAt) / 1000))
else
  if previousAt > 0 then encounterCount = encounterCount + 1 end
  continuityCount = 0
end
continuityCount = continuityCount + 1
local duration = tonumber(redis.call('HGET', KEYS[1], 'durationSeconds') or '0') + increment
local samples = tonumber(redis.call('HGET', KEYS[1], 'sampleCount') or '0') + 1
local minDistance = tonumber(redis.call('HGET', KEYS[1], 'minimumDistanceM') or ARGV[2])
if tonumber(ARGV[2]) < minDistance then minDistance = tonumber(ARGV[2]) end
local firstAt = redis.call('HGET', KEYS[1], 'firstSeenAtMs') or ARGV[1]
redis.call('HSET', KEYS[1], 'lowerUserId', ARGV[3], 'higherUserId', ARGV[4], 'firstSeenAtMs', firstAt,
  'lastSeenAtMs', ARGV[1], 'lastObservationAtMs', ARGV[1], 'observationCount', count + 1,
  'continuityCount', continuityCount, 'encounterCount', encounterCount, 'durationSeconds', duration,
  'sampleCount', samples, 'minimumDistanceM', minDistance, 'updatedAtMs', ARGV[1])
redis.call('EXPIRE', KEYS[1], 43200)
if continuityCount >= 2 then redis.call('ZADD', KEYS[3], ARGV[1], ARGV[5]) end
return {'accepted', tostring(increment), tostring(continuityCount)}
`;

export async function accumulateHeartbeatEncounter(userId: string, candidateUserIds: string[]): Promise<number> {
  if (!proximityRedis) return 0;
  const sourceRaw = await proximityRedis.get(proximityKeys.presence(userId)); if (!sourceRaw) return 0;
  const source = JSON.parse(sourceRaw) as ProximityPresence; const now = Date.now();
  if (now - source.serverSeenAtMs > (source.mode === 'event' ? 360_000 : 600_000) || source.accuracyM > 100) return 0;
  const sourceEligible = await prisma.user.findFirst({ where: { id: userId, isBanned: false, AND: [
    { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lt: new Date() } }] },
    { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lt: new Date() } }] },
  ],
    proximityPreference: { is: { crossedPathsDiscoverable: true } } }, select: {
      id: true, proximityPreference: { select: { publicForegroundPresenceEnabled: true } },
    } });
  if (!sourceEligible) return 0;
  if (source.mode === 'public' && !sourceEligible.proximityPreference?.publicForegroundPresenceEnabled) return 0;
  if (source.mode === 'event') {
    const activeSession = await prisma.proximity_sessions.findFirst({ where: {
      id: source.sessionId, userId, generation: source.generation, status: 'active', expiresAt: { gt: new Date(now) },
    }, select: { id: true } });
    if (!activeSession) return 0;
  }
  const blocked = new Set(await getBlockedUserIds(userId));
  const eligible = await prisma.user.findMany({ where: { id: { in: candidateUserIds.filter((id) => !blocked.has(id)) }, isBanned: false, AND: [
    { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lt: new Date() } }] },
    { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lt: new Date() } }] },
  ],
    proximityPreference: { is: { crossedPathsDiscoverable: true } } }, select: {
      id: true, proximityPreference: { select: { publicForegroundPresenceEnabled: true } },
    } });
  let accepted = 0;
  const targetPresence = eligible.length
    ? await proximityRedis.mget(...eligible.map((candidate) => proximityKeys.presence(candidate.id)))
    : [];
  const parsedTargets = targetPresence.map((raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw) as ProximityPresence; } catch { return null; }
  });
  const eventTargets = parsedTargets.filter((presence): presence is ProximityPresence => presence?.mode === 'event');
  const activeTargetSessions = eventTargets.length ? await prisma.proximity_sessions.findMany({ where: {
    id: { in: eventTargets.map((presence) => presence.sessionId) }, status: 'active', expiresAt: { gt: new Date(now) },
  }, select: { id: true, userId: true, generation: true } }) : [];
  const activeTargetSessionKeys = new Set(activeTargetSessions.map((session) => `${session.id}:${session.userId}:${session.generation}`));
  for (let index = 0; index < eligible.length; index += 1) {
    const candidate = eligible[index];
    const target = parsedTargets[index]; if (!target) continue;
    if (target.mode === 'public' && !candidate.proximityPreference?.publicForegroundPresenceEnabled) continue;
    if (target.mode === 'event'
      && !activeTargetSessionKeys.has(`${target.sessionId}:${target.userId}:${target.generation}`)) continue;
    if (now - target.serverSeenAtMs > (target.mode === 'event' ? 360_000 : 600_000) || target.accuracyM > 100) continue;
    const distanceM = haversineM(source.latitude, source.longitude, target.latitude, target.longitude);
    if (distanceM > Math.min(source.radiusM, target.radiusM)) continue;
    const [lower, higher] = canonicalPair(userId, candidate.id); const hash = pairHash(lower, higher);
    const observationHash = createHash('sha256').update([source.sampleId, target.sampleId].sort().join(':')).digest('hex').slice(0, 24);
    const observedAtMs = Math.min(source.serverSeenAtMs, target.serverSeenAtMs);
    const result = await proximityRedis.eval(ACCUMULATE_SCRIPT, 3, proximityKeys.accumulator(hash), proximityKeys.observation(hash, observationHash),
      proximityKeys.dirty(pairPartition(hash)), String(observedAtMs), String(distanceM), lower, higher, hash) as string[];
    if (result?.[0] === 'accepted' && Number(result[2]) >= 2) accepted += 1;
  }
  return accepted;
}

export async function persistEncounterDelta(delta: EncounterDelta): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.proximity_encounter_flush_receipts.create({ data: { flushId: delta.flushId, lowerUserId: delta.lowerUserId, higherUserId: delta.higherUserId } });
      const id = randomUUID(); const first = new Date(delta.firstSeenAt); const last = new Date(delta.lastSeenAt);
      const expires = new Date(last.getTime() + 7 * 86_400_000);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "proximity_encounter_pairs" ("id","lowerUserId","higherUserId","firstSeenAt","lastSeenAt","accumulatedDurationSeconds","sampleCount","minimumObservedDistanceM","encounterCount","areaLabel","expiresAt","createdAt","updatedAt")
        VALUES (${id},${delta.lowerUserId},${delta.higherUserId},${first},${last},${delta.durationSeconds},${delta.sampleCount},${delta.minimumDistanceM},${Math.max(1, delta.encounterIncrement)},${delta.areaLabel || null},${expires},NOW(),NOW())
        ON CONFLICT ("lowerUserId","higherUserId") DO UPDATE SET
          "firstSeenAt" = CASE WHEN "proximity_encounter_pairs"."expiresAt" <= ${first} THEN ${first} ELSE LEAST("proximity_encounter_pairs"."firstSeenAt", ${first}) END,
          "lastSeenAt" = GREATEST("proximity_encounter_pairs"."lastSeenAt", ${last}),
          "accumulatedDurationSeconds" = CASE WHEN "proximity_encounter_pairs"."expiresAt" <= ${first} THEN ${delta.durationSeconds} ELSE "proximity_encounter_pairs"."accumulatedDurationSeconds" + ${delta.durationSeconds} END,
          "sampleCount" = CASE WHEN "proximity_encounter_pairs"."expiresAt" <= ${first} THEN ${delta.sampleCount} ELSE "proximity_encounter_pairs"."sampleCount" + ${delta.sampleCount} END,
          "minimumObservedDistanceM" = CASE WHEN "proximity_encounter_pairs"."expiresAt" <= ${first} THEN ${delta.minimumDistanceM} ELSE LEAST("proximity_encounter_pairs"."minimumObservedDistanceM", ${delta.minimumDistanceM}) END,
          "encounterCount" = CASE WHEN "proximity_encounter_pairs"."expiresAt" <= ${first} THEN 1 ELSE "proximity_encounter_pairs"."encounterCount" + ${Math.max(0, delta.encounterIncrement)} END,
          "areaLabel" = COALESCE(${delta.areaLabel || null}, "proximity_encounter_pairs"."areaLabel"),
          "expiresAt" = GREATEST("proximity_encounter_pairs"."expiresAt", ${expires}), "updatedAt" = NOW()
        WHERE ${last} >= "proximity_encounter_pairs"."firstSeenAt"
        RETURNING "id"`);
      if (rows[0]) await tx.proximity_encounter_flush_receipts.update({ where: { flushId: delta.flushId }, data: { encounterId: rows[0].id } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    throw error;
  }
}
