import { createHash } from 'crypto';
import { prisma } from '../config/prisma';
import { getBlockedUserIds } from './trust-safety.service';
import { proximityRedis, isProximityRedisReady } from '../infrastructure/proximity/redis-client';
import { atomicHeartbeat } from '../infrastructure/proximity/redis-scripts';
import { deterministicCohort, encodeGeohash, filterActiveShardsForRadius, radiusShardSearchPlan } from '../infrastructure/proximity/geo-shards';
import { PROXIMITY_EVENT_TTL_SECONDS, PROXIMITY_IDEMPOTENCY_TTL_SECONDS, PROXIMITY_LIVE_SNAPSHOT_TTL_SECONDS, PROXIMITY_PUBLIC_TTL_SECONDS, proximityKeys } from '../infrastructure/proximity/redis-keys';
import { getProximityQueue, proximityQueueNames } from '../infrastructure/proximity/queues';
import type { ProximityHeartbeatInput, ProximityHeartbeatResponse, ProximityMode, ProximityPresence } from '../types/proximity.types';
import { displaceMarker } from './proximity-privacy.service';
import { getProximityFeatureFlagsForUser } from './proximity-feature-flags.service';
import { proximityCandidateGauge, proximityDegradedCounter } from '../infrastructure/metrics/registry';
import { decodeKeysetCursor, encodeKeysetCursor } from '../utils/keyset-pagination.util';
import { ProximityValidationError } from '../utils/proximity-validation.util';

export class ProximityServiceError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly retryable = false) { super(code); }
}

function cadence(sample: ProximityHeartbeatInput, nearbyCount: number, seed: string): number {
  const base = nearbyCount === 0 ? 120 : sample.movement === 'stationary' ? 105 : 60;
  const value = createHash('sha256').update(seed).digest().readUInt16BE(0) / 0xffff;
  return Math.max(45, Math.min(120, Math.round(base * (0.9 + value * 0.2))));
}

async function eligibleCandidates(viewerId: string, idsByDistance: Array<{ userId: string; distanceM: number }>) {
  if (!idsByDistance.length) return [];
  const blocked = new Set(await getBlockedUserIds(viewerId));
  const ids = idsByDistance.map((item) => item.userId).filter((id) => id !== viewerId && !blocked.has(id));
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isBanned: false, AND: [
      { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lt: new Date() } }] },
      { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lt: new Date() } }] },
    ], proximityPreference: { is: { crossedPathsDiscoverable: true } } },
    select: { id: true },
  });
  const allowed = new Set(users.map((user) => user.id));
  return idsByDistance.filter((item) => allowed.has(item.userId));
}

async function searchCandidates(latitude: number, longitude: number, radiusM: number, viewerId: string) {
  if (!proximityRedis) return [];
  const searchPlan = radiusShardSearchPlan(latitude, longitude, radiusM);
  const shards = searchPlan.useActiveShardRegistry
    ? filterActiveShardsForRadius(await proximityRedis.smembers(proximityKeys.shards), latitude, longitude, radiusM)
    : searchPlan.shards;
  const byUser = new Map<string, number>();
  const cohort = deterministicCohort(`${viewerId}:${Math.floor(Date.now() / 60_000)}`);
  const pipeline = proximityRedis.pipeline();
  for (const shard of shards) {
    for (const mode of ['event', 'public'] as const) {
      pipeline.call('GEOSEARCH', proximityKeys.geo(mode, shard), 'FROMLONLAT', String(longitude), String(latitude),
        'BYRADIUS', String(radiusM), 'm', 'ASC', 'COUNT', '250', 'WITHDIST');
      pipeline.call('GEOSEARCH', proximityKeys.geoCohort(mode, shard, cohort), 'FROMLONLAT', String(longitude), String(latitude),
        'BYRADIUS', String(radiusM), 'm', 'ASC', 'COUNT', '80', 'WITHDIST');
    }
  }
  const results = await pipeline.exec();
  for (const [error, value] of results || []) {
    if (error) continue;
    for (const row of (value || []) as Array<[string, string]>) {
      const candidateId = String(row[0]); const distanceM = Number(row[1]);
      if (Number.isFinite(distanceM) && (!byUser.has(candidateId) || distanceM < byUser.get(candidateId)!)) {
        byUser.set(candidateId, distanceM);
      }
    }
  }
  return eligibleCandidates(viewerId, Array.from(byUser, ([userId, distanceM]) => ({ userId, distanceM })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 330));
}

export async function processHeartbeat(userId: string, session: { id: string; generation: number; radiusM: number; expiresAt: Date }, sample: ProximityHeartbeatInput): Promise<ProximityHeartbeatResponse> {
  if (!isProximityRedisReady() || !proximityRedis) throw new ProximityServiceError('PROXIMITY_REDIS_UNAVAILABLE', 503, true);
  if (session.expiresAt <= new Date()) throw new ProximityServiceError('PROXIMITY_SESSION_EXPIRED', 410);
  if (sample.generation !== session.generation) throw new ProximityServiceError('PROXIMITY_SEQUENCE_CONFLICT', 409);
  const cachedKey = proximityKeys.response(session.id, sample.generation, sample.sequence);
  const cached = await proximityRedis.get(cachedKey);
  if (cached) return { ...JSON.parse(cached), duplicate: true };
  const now = Date.now();
  const shard = encodeGeohash(sample.latitude, sample.longitude);
  const cohort = deterministicCohort(userId);
  const presence: ProximityPresence = {
    userId, mode: 'event', sessionId: session.id, generation: sample.generation, sequence: sample.sequence,
    sampleId: sample.sampleId, latitude: sample.latitude, longitude: sample.longitude, accuracyM: sample.accuracyM,
    capturedAtMs: new Date(sample.capturedAt).getTime(), serverSeenAtMs: now, radiusM: session.radiusM, shard, cohort,
  };
  const fallbackResponse: ProximityHeartbeatResponse = { version: 1, accepted: true, duplicate: false,
    nearbyCount: 0, nearbyCountCapped: false,
    nextHeartbeatAfterSeconds: cadence(sample, 0, `${session.id}:${sample.sequence}`),
    sessionExpiresAt: session.expiresAt.toISOString(), degradedMode: 'live_unavailable', historyLagging: true };
  const atomic = await atomicHeartbeat(proximityRedis, {
    sessionKey: proximityKeys.session(session.id), sampleKey: proximityKeys.sample(session.id, sample.sampleId),
    presenceKey: proximityKeys.presence(userId), geoKey: proximityKeys.geo('event', shard),
    cohortKey: proximityKeys.geoCohort('event', shard, cohort), lastSeenKey: proximityKeys.lastSeen(shard),
    shardsKey: proximityKeys.shards, responseKey: cachedKey, generation: sample.generation, sequence: sample.sequence, sampleId: sample.sampleId,
    userId, longitude: sample.longitude, latitude: sample.latitude, ttlSeconds: PROXIMITY_EVENT_TTL_SECONDS,
    idempotencyTtlSeconds: PROXIMITY_IDEMPOTENCY_TTL_SECONDS, presenceJson: JSON.stringify(presence), serverSeenAtMs: now,
    sessionTtlSeconds: Math.max(PROXIMITY_IDEMPOTENCY_TTL_SECONDS, Math.ceil((session.expiresAt.getTime() - now) / 1_000) + 600),
    responseJson: JSON.stringify(fallbackResponse),
  });
  if (atomic === 'out_of_order') throw new ProximityServiceError('PROXIMITY_OUT_OF_ORDER', 409);
  if (atomic === 'conflict') throw new ProximityServiceError('PROXIMITY_SEQUENCE_CONFLICT', 409);
  if (atomic === 'duplicate' || atomic === 'sample_duplicate') {
    const response = await proximityRedis.get(cachedKey);
    if (response) return { ...JSON.parse(response), duplicate: true };
    throw new ProximityServiceError('PROXIMITY_SEQUENCE_CONFLICT', 409);
  }
  let candidateSearchFailed = false;
  const candidates = await searchCandidates(sample.latitude, sample.longitude, session.radiusM, userId).catch(() => {
    candidateSearchFailed = true;
    return [];
  });
  proximityCandidateGauge.set({ state: 'evaluated' }, candidates.length);
  proximityCandidateGauge.set({ state: 'capped' }, candidates.length > 200 ? 1 : 0);
  const flags = getProximityFeatureFlagsForUser(userId);
  let historyLagging = candidateSearchFailed;
  if (flags.accumulation && candidates.length > 0) {
    try {
      const queue = getProximityQueue(proximityQueueNames.accumulation);
      const highWater = Number(process.env.PROXIMITY_QUEUE_HIGH_WATER || 20_000);
      if (await queue.getWaitingCount() >= highWater) {
        historyLagging = true;
      } else {
        const jobId = `hb-${session.id}-${sample.generation}-${sample.sequence}-${sample.sampleId}`;
        await queue.add('proximity-accumulate-heartbeat', { version: 1, sessionId: session.id, generation: sample.generation,
          sequence: sample.sequence, sampleId: sample.sampleId, userId, candidateUserIds: candidates.slice(0, 330).map((x) => x.userId) }, { jobId });
      }
    } catch { historyLagging = true; }
  }
  const response: ProximityHeartbeatResponse = { version: 1, accepted: true, duplicate: false,
    nearbyCount: Math.min(200, candidates.length), nearbyCountCapped: candidates.length > 200,
    nextHeartbeatAfterSeconds: cadence(sample, candidates.length, `${session.id}:${sample.sequence}`),
    sessionExpiresAt: session.expiresAt.toISOString(), degradedMode: candidateSearchFailed ? 'live_unavailable' : historyLagging ? 'history_lagging' : 'none', historyLagging };
  if (historyLagging) proximityDegradedCounter.inc({ mode: candidateSearchFailed ? 'live_unavailable' : 'history_lagging' });
  await proximityRedis.set(cachedKey, JSON.stringify(response), 'EX', PROXIMITY_IDEMPOTENCY_TTL_SECONDS);
  void prisma.proximity_sessions.update({ where: { id: session.id }, data: { lastHeartbeatAt: new Date(now) } }).catch(() => undefined);
  return response;
}

export async function publishPublicPresence(userId: string, sample: ProximityHeartbeatInput): Promise<ProximityHeartbeatResponse> {
  if (!isProximityRedisReady() || !proximityRedis) throw new ProximityServiceError('PROXIMITY_REDIS_UNAVAILABLE', 503, true);
  const cachedKey = proximityKeys.response(sample.sessionId, sample.generation, sample.sequence);
  const cached = await proximityRedis.get(cachedKey);
  if (cached) return { ...JSON.parse(cached), duplicate: true };
  const shard = encodeGeohash(sample.latitude, sample.longitude); const cohort = deterministicCohort(userId); const now = Date.now();
  const presence: ProximityPresence = { userId, mode: 'public', sessionId: sample.sessionId, generation: sample.generation, sequence: sample.sequence,
    sampleId: sample.sampleId, latitude: sample.latitude, longitude: sample.longitude, accuracyM: sample.accuracyM,
    capturedAtMs: new Date(sample.capturedAt).getTime(), serverSeenAtMs: now, radiusM: 500, shard, cohort };
  const fallbackResponse: ProximityHeartbeatResponse = { version: 1, accepted: true, duplicate: false,
    nearbyCount: 0, nearbyCountCapped: false, nextHeartbeatAfterSeconds: 120,
    sessionExpiresAt: new Date(now + PROXIMITY_PUBLIC_TTL_SECONDS * 1_000).toISOString(),
    degradedMode: 'live_unavailable', historyLagging: true };
  const atomic = await atomicHeartbeat(proximityRedis, { sessionKey: proximityKeys.session(sample.sessionId), sampleKey: proximityKeys.sample(sample.sessionId, sample.sampleId),
    presenceKey: proximityKeys.presence(userId), geoKey: proximityKeys.geo('public', shard), cohortKey: proximityKeys.geoCohort('public', shard, cohort),
    lastSeenKey: proximityKeys.lastSeen(shard), shardsKey: proximityKeys.shards, responseKey: cachedKey,
    generation: sample.generation, sequence: sample.sequence,
    sampleId: sample.sampleId, userId, longitude: sample.longitude, latitude: sample.latitude, ttlSeconds: PROXIMITY_PUBLIC_TTL_SECONDS,
    idempotencyTtlSeconds: PROXIMITY_IDEMPOTENCY_TTL_SECONDS, presenceJson: JSON.stringify(presence), serverSeenAtMs: now,
    sessionTtlSeconds: PROXIMITY_IDEMPOTENCY_TTL_SECONDS, responseJson: JSON.stringify(fallbackResponse) });
  if (atomic === 'out_of_order') throw new ProximityServiceError('PROXIMITY_OUT_OF_ORDER', 409);
  if (atomic === 'conflict') throw new ProximityServiceError('PROXIMITY_SEQUENCE_CONFLICT', 409);
  if (atomic === 'duplicate' || atomic === 'sample_duplicate') {
    const duplicateResponse = await proximityRedis.get(cachedKey);
    if (duplicateResponse) return { ...JSON.parse(duplicateResponse), duplicate: true };
    throw new ProximityServiceError('PROXIMITY_SEQUENCE_CONFLICT', 409);
  }
  let candidateSearchFailed = false;
  const candidates = await searchCandidates(sample.latitude, sample.longitude, 500, userId).catch(() => {
    candidateSearchFailed = true;
    return [];
  });
  proximityCandidateGauge.set({ state: 'evaluated' }, candidates.length);
  proximityCandidateGauge.set({ state: 'capped' }, candidates.length > 200 ? 1 : 0);
  let historyLagging = candidateSearchFailed;
  if (getProximityFeatureFlagsForUser(userId).accumulation && candidates.length > 0) {
    try {
      const queue = getProximityQueue(proximityQueueNames.accumulation);
      const highWater = Number(process.env.PROXIMITY_QUEUE_HIGH_WATER || 20_000);
      if (await queue.getWaitingCount() >= highWater) {
        historyLagging = true;
      } else {
        await queue.add('proximity-accumulate-heartbeat', { version: 1, sessionId: sample.sessionId, generation: sample.generation,
          sequence: sample.sequence, sampleId: sample.sampleId, userId, candidateUserIds: candidates.slice(0, 330).map((item) => item.userId) },
        { jobId: `hb-${sample.sessionId}-${sample.generation}-${sample.sequence}-${sample.sampleId}` });
      }
    } catch { historyLagging = true; }
  }
  const response: ProximityHeartbeatResponse = { version: 1, accepted: true, duplicate: false,
    nearbyCount: Math.min(200, candidates.length), nearbyCountCapped: candidates.length > 200,
    nextHeartbeatAfterSeconds: 120, sessionExpiresAt: new Date(now + PROXIMITY_PUBLIC_TTL_SECONDS * 1_000).toISOString(),
    degradedMode: candidateSearchFailed ? 'live_unavailable' : historyLagging ? 'history_lagging' : 'none', historyLagging };
  if (historyLagging) proximityDegradedCounter.inc({ mode: candidateSearchFailed ? 'live_unavailable' : 'history_lagging' });
  await proximityRedis.set(cachedKey, JSON.stringify(response), 'EX', PROXIMITY_IDEMPOTENCY_TTL_SECONDS);
  return response;
}

export async function getLiveProximity(viewerId: string, viewerSessionId: string, input: {
  radiusM: number;
  cursor?: string;
  limit: number;
  viewport?: { minLatitude: number; minLongitude: number; maxLatitude: number; maxLongitude: number };
}) {
  if (!isProximityRedisReady() || !proximityRedis) throw new ProximityServiceError('PROXIMITY_REDIS_UNAVAILABLE', 503, true);
  const raw = await proximityRedis.get(proximityKeys.presence(viewerId));
  if (!raw) return { markers: [], people: [], nearbyCount: 0, nearbyCountCapped: false, totalLabel: '0', nextCursor: null };
  const viewer = JSON.parse(raw) as ProximityPresence;
  const queryHash = createHash('sha256').update(JSON.stringify({ radiusM: input.radiusM, viewport: input.viewport || null })).digest('hex').slice(0, 20);
  const cursorScope = `proximity-live:${viewerSessionId}:${queryHash}`;
  const cursor = decodeKeysetCursor(input.cursor, cursorScope);
  if (input.cursor && (!cursor || cursor.n === undefined || cursor.n < 0)) {
    throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'Live cursor is invalid or expired');
  }
  const snapshotKey = proximityKeys.liveSnapshot(viewerSessionId, queryHash);
  let candidates: Array<{ userId: string; distanceM: number }>;
  const snapshot = await proximityRedis.get(snapshotKey);
  if (snapshot) {
    candidates = JSON.parse(snapshot) as Array<{ userId: string; distanceM: number }>;
  } else {
    if (input.cursor) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'Live cursor is invalid or expired');
    candidates = await searchCandidates(viewer.latitude, viewer.longitude, input.radiusM, viewerId);
    await proximityRedis.set(snapshotKey, JSON.stringify(candidates.slice(0, 330)), 'EX', PROXIMITY_LIVE_SNAPSHOT_TTL_SECONDS);
  }
  // Snapshot membership is stable for pagination, but safety and opt-in state are authoritative per response.
  candidates = await eligibleCandidates(viewerId, candidates);
  const offset = cursor?.n || 0;
  const markerCandidates = candidates.slice(0, 200);
  const pageCandidates = candidates.slice(offset, offset + input.limit);
  const requestedIds = Array.from(new Set([...markerCandidates, ...pageCandidates].map((item) => item.userId)));
  const profiles = await prisma.user.findMany({ where: { id: { in: requestedIds } },
    select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true,
      proximityPreference: { select: { publicForegroundPresenceEnabled: true } } } });
  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const presenceValues = requestedIds.length ? await proximityRedis.mget(...requestedIds.map((id) => proximityKeys.presence(id))) : [];
  const presenceMap = new Map<string, ProximityPresence>();
  requestedIds.forEach((id, index) => {
    const value = presenceValues[index];
    if (!value) return;
    try { presenceMap.set(id, JSON.parse(value) as ProximityPresence); } catch { /* expiring malformed presence is ignored */ }
  });
  const eventPresences = Array.from(presenceMap.values()).filter((presence) => presence.mode === 'event');
  const activeEventSessions = eventPresences.length ? await prisma.proximity_sessions.findMany({ where: {
    id: { in: eventPresences.map((presence) => presence.sessionId) }, status: 'active', expiresAt: { gt: new Date() },
  }, select: { id: true, userId: true, generation: true } }) : [];
  const validEventSessions = new Set(activeEventSessions.map((session) => `${session.id}:${session.userId}:${session.generation}`));
  const rendered = new Map<string, any>();
  for (const item of [...markerCandidates, ...pageCandidates]) {
    if (rendered.has(item.userId)) continue;
    const target = presenceMap.get(item.userId);
    const profile = profileMap.get(item.userId);
    if (!target || !profile) continue;
    if (target.mode === 'public' && !profile.proximityPreference?.publicForegroundPresenceEnabled) continue;
    if (target.mode === 'event'
      && !validEventSessions.has(`${target.sessionId}:${target.userId}:${target.generation}`)) continue;
    const marker = displaceMarker({ latitude: target.latitude, longitude: target.longitude, viewerId,
      targetId: target.userId, viewerSessionId, targetGeneration: target.generation, mode: target.mode });
    rendered.set(item.userId, { id: profile.id, username: profile.username, name: profile.name, profileImage: profile.profileImage,
      headline: profile.headline, college: profile.college,
      distanceBucket: item.distanceM < 100 ? 'under_100m' : item.distanceM < 300 ? '100_300m' : '300_500m',
      approximateLatitude: marker.latitude, approximateLongitude: marker.longitude, presenceMode: target.mode });
  }
  const inViewport = (person: any) => !input.viewport || (person.approximateLatitude >= input.viewport.minLatitude
    && person.approximateLatitude <= input.viewport.maxLatitude && (input.viewport.minLongitude <= input.viewport.maxLongitude
      ? person.approximateLongitude >= input.viewport.minLongitude && person.approximateLongitude <= input.viewport.maxLongitude
      : person.approximateLongitude >= input.viewport.minLongitude || person.approximateLongitude <= input.viewport.maxLongitude));
  const markers = markerCandidates.map((candidate) => rendered.get(candidate.userId)).filter(Boolean).filter(inViewport)
    .map((person) => ({ userId: person.id, latitude: person.approximateLatitude, longitude: person.approximateLongitude,
      profileImage: person.profileImage, mode: person.presenceMode }));
  const people = pageCandidates.map((candidate) => rendered.get(candidate.userId)).filter(Boolean);
  const nextOffset = offset + input.limit;
  return { markers, people, nearbyCount: Math.min(200, candidates.length), nearbyCountCapped: candidates.length > 200,
    totalLabel: candidates.length > 200 ? '200+' : String(candidates.length), nextCursor: nextOffset < candidates.length
      ? encodeKeysetCursor({ id: 'page', n: nextOffset, scope: cursorScope }) : null };
}
