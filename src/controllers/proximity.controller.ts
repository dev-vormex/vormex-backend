import type { Response } from 'express';
import { prisma } from '../config/prisma';
import type { AuthenticatedRequest } from '../types/auth.types';
import { getProximityFeatureFlagsForUser } from '../services/proximity-feature-flags.service';
import { ProximityValidationError, validateHeartbeat, validateRadius, validateSessionStart, validateUuid } from '../utils/proximity-validation.util';
import { getCurrentProximitySession, resumeProximitySession, startProximitySession, stopProximitySession } from '../services/proximity-session.service';
import { getLiveProximity, processHeartbeat, ProximityServiceError, publishPublicPresence } from '../services/proximity-presence.service';
import { removeUserProximityPresence } from '../services/proximity-privacy.service';
import { getProximityHistory, removeAllProximityHistory, removeProximityHistory, setProximityHidden } from '../services/proximity-history.service';
import { markProximitySummaryViewed, pendingProximitySummaries } from '../services/proximity-summary.service';
import { getProximityQueue, proximityQueueNames } from '../infrastructure/proximity/queues';
import { getProximityRedisHealth } from '../infrastructure/proximity/redis-client';
import { proximityHeartbeatCounter, proximityHeartbeatDuration } from '../infrastructure/metrics/registry';

function userId(req: AuthenticatedRequest): string { return String(req.user?.userId || ''); }
function flags(req: AuthenticatedRequest) {
  return getProximityFeatureFlagsForUser(userId(req), String(req.headers['x-vormex-install-id'] || ''));
}
function error(res: Response, status: number, code: string, message = code, retryable = false): void {
  res.status(status).json({ error: { code, message, retryable } });
}

function handle(errorValue: unknown, res: Response): void {
  if (errorValue instanceof ProximityValidationError) return error(res, errorValue.status, errorValue.code, errorValue.message);
  if (errorValue instanceof ProximityServiceError) return error(res, errorValue.status, errorValue.code, errorValue.code, errorValue.retryable);
  if (errorValue instanceof Error && errorValue.message === 'PROXIMITY_SESSION_EXPIRED') return error(res, 410, errorValue.message);
  console.error('proximity endpoint failed:', errorValue);
  error(res, 500, 'PROXIMITY_SERVICE_DEGRADED', 'Crossed Paths is temporarily unavailable', true);
}

export async function getCapabilities(req: AuthenticatedRequest, res: Response): Promise<void> {
  const effectiveFlags = flags(req);
  res.json({ data: { version: 1, flags: effectiveFlags, supportedRadiiM: [200, 300, 500], heartbeatSeconds: { min: 45, max: 120 },
    tile: { provider: 'openstreetmap', url: process.env.PROXIMITY_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', version: process.env.PROXIMITY_TILE_CONFIG_VERSION || '1' },
    degradedMode: getProximityRedisHealth().ready ? 'none' : 'live_unavailable' } });
}

export async function getSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const data = await prisma.proximity_preferences.findUnique({ where: { userId: userId(req) } });
    res.json({ data: data || { crossedPathsDiscoverable: false, publicForegroundPresenceEnabled: false, summaryNotificationsEnabled: true } });
  } catch (e) { handle(e, res); }
}

export async function updateSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const allowed = ['crossedPathsDiscoverable','publicForegroundPresenceEnabled','summaryNotificationsEnabled'];
    if (Object.keys(req.body || {}).some((key) => !allowed.includes(key)) || allowed.some((key) => req.body?.[key] !== undefined && typeof req.body[key] !== 'boolean')) {
      throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'Settings must contain only boolean proximity preferences');
    }
    const owner = userId(req); const discoverable = req.body.crossedPathsDiscoverable;
    const data = await prisma.proximity_preferences.upsert({ where: { userId: owner }, create: { userId: owner,
      crossedPathsDiscoverable: discoverable ?? false, publicForegroundPresenceEnabled: req.body.publicForegroundPresenceEnabled ?? false,
      summaryNotificationsEnabled: req.body.summaryNotificationsEnabled ?? true, consentVersion: discoverable ? 'crossed-paths-v1' : null, consentedAt: discoverable ? new Date() : null },
      update: { ...req.body, ...(discoverable === true ? { consentVersion: 'crossed-paths-v1', consentedAt: new Date() } : {}) } });
    if (discoverable === false) {
      await prisma.proximity_sessions.updateMany({ where: { userId: owner, status: 'active' }, data: { status: 'invalidated', endedAt: new Date(), endReason: 'discoverability_disabled' } });
      await removeUserProximityPresence(owner);
    }
    res.json({ data });
  } catch (e) { handle(e, res); }
}

export async function createSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!flags(req).eventMode) throw new ProximityServiceError('PROXIMITY_FEATURE_DISABLED', 403);
    if (!getProximityRedisHealth().ready) throw new ProximityServiceError('PROXIMITY_REDIS_UNAVAILABLE', 503, true);
    const owner = userId(req); const preferences = await prisma.proximity_preferences.findUnique({ where: { userId: owner } });
    if (!preferences?.crossedPathsDiscoverable) throw new ProximityServiceError('PROXIMITY_PERMISSION_DISABLED', 403);
    const start = validateSessionStart(req.body || {});
    const started = await startProximitySession({ userId: owner, authSessionId: req.user?.sessionId, installId: String(req.headers['x-vormex-install-id'] || ''),
      clientStartId: start.clientStartId, radiusM: start.radiusM });
    const session = started.session;
    let heartbeat: { nextHeartbeatAfterSeconds: number; degradedMode: string } = { nextHeartbeatAfterSeconds: 120, degradedMode: 'none' };
    if (started.isNew && session.status === 'active') {
      try {
        heartbeat = await processHeartbeat(owner, session, { ...start, sessionId: session.id, generation: session.generation, sequence: 1 });
      } catch (initialHeartbeatError) {
        await prisma.proximity_sessions.updateMany({ where: { id: session.id, status: 'active' }, data: {
          status: 'invalidated', endedAt: new Date(), endReason: 'initial_heartbeat_failed',
        } });
        await removeUserProximityPresence(owner);
        throw initialHeartbeatError;
      }
    }
    res.status(201).json({ data: { version: 1, sessionId: session.id, generation: session.generation, status: session.status,
      sessionExpiresAt: session.expiresAt, nextHeartbeatAfterSeconds: heartbeat.nextHeartbeatAfterSeconds, acceptedPrecision: start.accuracyM > 50 ? 'approximate' : 'precise', degradedMode: heartbeat.degradedMode } });
  } catch (e) { handle(e, res); }
}

export async function currentSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  try { res.json({ data: await getCurrentProximitySession(userId(req)) }); } catch (e) { handle(e, res); }
}

export async function resumeSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  try { res.json({ data: await resumeProximitySession(userId(req), validateUuid(req.params.sessionId, 'sessionId')) }); } catch (e) { handle(e, res); }
}

export async function heartbeat(req: AuthenticatedRequest, res: Response): Promise<void> {
  const stopTimer = proximityHeartbeatDuration.startTimer();
  try {
    const owner = userId(req); const sessionId = String(req.params.sessionId); const input = validateHeartbeat(req.body || {}, sessionId);
    const session = await prisma.proximity_sessions.findFirst({ where: { id: sessionId, userId: owner } });
    if (!session || session.status !== 'active') throw new ProximityServiceError('PROXIMITY_SESSION_EXPIRED', 410);
    const result = await processHeartbeat(owner, session, input);
    const outcome = result.duplicate ? 'duplicate' : 'accepted';
    proximityHeartbeatCounter.inc({ outcome, reason: 'none' });
    stopTimer({ outcome });
    res.json({ data: result });
  } catch (e) {
    const reason = e instanceof ProximityServiceError || e instanceof ProximityValidationError ? e.code : 'unknown';
    proximityHeartbeatCounter.inc({ outcome: 'rejected', reason });
    stopTimer({ outcome: 'rejected' });
    handle(e, res);
  }
}

export async function stopSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const session = await stopProximitySession(userId(req), validateUuid(req.params.sessionId, 'sessionId'));
    if (session && !session.summaryReadyAt && flags(req).summaryNotifications) {
      try {
        getProximityQueue(proximityQueueNames.summary)
          .add('proximity-generate-summary', { sessionId: session.id }, { jobId: `summary-${session.id}`, delay: 120_000 })
          .catch(() => undefined);
      } catch {
        // PostgreSQL remains authoritative; the pending summary can be generated after Redis recovers.
      }
    }
    res.json({ data: session ? { status: session.status, summaryStatus: session.summaryStatus, summaryCount: session.summaryCount } : { status: 'already_stopped', summaryStatus: 'pending', summaryCount: null } });
  } catch (e) { handle(e, res); }
}

export async function publicPresence(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!flags(req).publicPresence) throw new ProximityServiceError('PROXIMITY_FEATURE_DISABLED', 403);
    const owner = userId(req);
    if (req.body?.clear === true) {
      if (Object.keys(req.body).some((key) => key !== 'clear')) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'Clear requests accept only clear=true');
      await removeUserProximityPresence(owner);
      res.json({ data: { accepted: true, duplicate: false, cleared: true, nextHeartbeatAfterSeconds: 120 } });
      return;
    }
    const pref = await prisma.proximity_preferences.findUnique({ where: { userId: owner } });
    if (!pref?.crossedPathsDiscoverable || !pref.publicForegroundPresenceEnabled) throw new ProximityServiceError('PROXIMITY_PERMISSION_DISABLED', 403);
    const sessionId = String(req.body?.sessionId || '');
    const input = validateHeartbeat(req.body || {}, sessionId);
    res.json({ data: await publishPublicPresence(owner, input) });
  } catch (e) { handle(e, res); }
}

export async function live(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!flags(req).liveList) throw new ProximityServiceError('PROXIMITY_FEATURE_DISABLED', 403);
    const session = await getCurrentProximitySession(userId(req)); const sessionId = session?.id || String(req.query.sessionId || 'foreground');
    const allowed = new Set(['radiusM', 'viewport', 'cursor', 'limit', 'sessionId']);
    const extra = Object.keys(req.query).find((key) => !allowed.has(key));
    if (extra) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', `Unexpected query field: ${extra}`);
    let viewport: { minLatitude: number; minLongitude: number; maxLatitude: number; maxLongitude: number } | undefined;
    if (typeof req.query.viewport === 'string' && req.query.viewport.trim()) {
      const values = req.query.viewport.split(',').map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[0] < -90 || values[2] > 90
        || values[1] < -180 || values[3] > 180 || values[0] >= values[2]) {
        throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'viewport must be minLat,minLon,maxLat,maxLon');
      }
      viewport = { minLatitude: values[0], minLongitude: values[1], maxLatitude: values[2], maxLongitude: values[3] };
    }
    const limit = Number(req.query.limit || 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'limit must be between 1 and 50');
    }
    res.json({ data: await getLiveProximity(userId(req), sessionId, {
      radiusM: validateRadius(req.query.radiusM || session?.radiusM || 500),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit, viewport,
    }) });
  } catch (e) { handle(e, res); }
}

export async function history(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const allowed = new Set(['tab', 'sort', 'cursor', 'limit', 'query', 'filters']);
    const extra = Object.keys(req.query).find((key) => !allowed.has(key));
    if (extra) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', `Unexpected query field: ${extra}`);
    const tab = req.query.tab === undefined ? 'seven_days' : String(req.query.tab);
    const sort = req.query.sort === undefined ? 'recent' : String(req.query.sort);
    if (tab !== 'today' && tab !== 'seven_days') throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'tab must be today or seven_days');
    if (sort !== 'recent' && sort !== 'duration') throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'sort must be recent or duration');
    const limit = Number(req.query.limit || 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'limit must be between 1 and 50');
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : undefined;
    if (query && query.length > 80) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'query must be at most 80 characters');
    const relationshipFilters = typeof req.query.filters === 'string' && req.query.filters.trim()
      ? Array.from(new Set(req.query.filters.split(',').map((value) => value.trim()).filter(Boolean))) : [];
    const validFilters = new Set(['none', 'pending_sent', 'pending_received', 'connected']);
    if (relationshipFilters.some((value) => !validFilters.has(value))) {
      throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'filters contain an unsupported relationship state');
    }
    res.json({ data: await getProximityHistory(userId(req), { tab, sort,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined, limit, query, relationshipFilters }) });
  } catch (e) { handle(e, res); }
}

export async function removeHistory(req: AuthenticatedRequest, res: Response): Promise<void> { try { res.json({ data: { removed: await removeProximityHistory(userId(req), String(req.params.targetUserId)) } }); } catch (e) { handle(e, res); } }
export async function removeAllHistory(req: AuthenticatedRequest, res: Response): Promise<void> { try { res.json({ data: { removedCount: await removeAllProximityHistory(userId(req)) } }); } catch (e) { handle(e, res); } }
export async function hideHistory(req: AuthenticatedRequest, res: Response): Promise<void> { try { if (typeof req.body?.hidden !== 'boolean') throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'hidden must be boolean'); res.json({ data: { updated: await setProximityHidden(userId(req), String(req.params.targetUserId), req.body.hidden), hidden: req.body.hidden } }); } catch (e) { handle(e, res); } }
export async function pendingSummaries(req: AuthenticatedRequest, res: Response): Promise<void> { try { res.json({ data: await pendingProximitySummaries(userId(req)) }); } catch (e) { handle(e, res); } }
export async function summaryViewed(req: AuthenticatedRequest, res: Response): Promise<void> { try { await markProximitySummaryViewed(userId(req), validateUuid(req.params.sessionId, 'sessionId')); res.json({ data: { viewed: true } }); } catch (e) { handle(e, res); } }
