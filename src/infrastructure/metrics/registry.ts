import client from 'prom-client';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestDuration = new client.Histogram({
  name: 'vormex_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [25, 50, 100, 200, 300, 500, 1_000, 2_000, 5_000],
  registers: [register],
});

export const outboxDispatchCounter = new client.Counter({
  name: 'vormex_outbox_dispatch_total',
  help: 'Outbox dispatch attempts',
  labelNames: ['status', 'queue'],
  registers: [register],
});

export const queueBacklogGauge = new client.Gauge({
  name: 'vormex_queue_backlog',
  help: 'Approximate queue backlog by queue name',
  labelNames: ['queue'],
  registers: [register],
});

export const emergencyRateLimitCounter = new client.Counter({
  name: 'vormex_rate_limit_emergency_total',
  help: 'Emergency in-process rate limiter decisions while Redis rate limiting is unavailable',
  labelNames: ['action', 'key_prefix'],
  registers: [register],
});

export const thirdPartyHttpCounter = new client.Counter({
  name: 'vormex_third_party_http_total',
  help: 'Outbound third-party HTTP call outcomes by provider and operation',
  labelNames: ['provider', 'operation', 'outcome'],
  registers: [register],
});

export const processErrorCounter = new client.Counter({
  name: 'vormex_process_error_total',
  help: 'Fatal process-level error events handled by the API process',
  labelNames: ['type'],
  registers: [register],
});

export const pushNotificationConfigCounter = new client.Counter({
  name: 'vormex_push_notification_config_total',
  help: 'Push notification startup/configuration states',
  labelNames: ['state'],
  registers: [register],
});

export const cacheOutcomeCounter = new client.Counter({
  name: 'vormex_cache_outcome_total',
  help: 'Application cache outcomes by operation',
  labelNames: ['operation', 'outcome'],
  registers: [register],
});

export const cacheRequestCounter = new client.Counter({
  name: 'vormex_cache_request_total',
  help: 'Application cache requests by operation, outcome, backend, and bounded namespace',
  labelNames: ['operation', 'outcome', 'backend', 'namespace'],
  registers: [register],
});

export const cacheOperationDuration = new client.Histogram({
  name: 'vormex_cache_operation_duration_ms',
  help: 'Application cache operation duration in milliseconds',
  labelNames: ['operation', 'outcome', 'backend', 'namespace'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000],
  registers: [register],
});

export const profileViewAnalyticsCounter = new client.Counter({
  name: 'vormex_profile_view_analytics_total',
  help: 'Automatic profile-view analytics queue outcomes',
  labelNames: ['outcome'],
  registers: [register],
});

export const dbConnectionGauge = new client.Gauge({
  name: 'vormex_db_connections',
  help: 'Postgres connections visible to the current database, grouped by connection state',
  labelNames: ['state'],
  registers: [register],
});

export const proximityHeartbeatDuration = new client.Histogram({
  name: 'vormex_proximity_heartbeat_duration_ms', help: 'Crossed Paths heartbeat latency', labelNames: ['outcome'],
  buckets: [25, 50, 100, 200, 300, 500, 1_000, 2_000], registers: [register],
});
export const proximityHeartbeatCounter = new client.Counter({
  name: 'vormex_proximity_heartbeat_total', help: 'Crossed Paths heartbeat outcomes', labelNames: ['outcome', 'reason'], registers: [register],
});
export const proximityCandidateGauge = new client.Gauge({
  name: 'vormex_proximity_candidate_count', help: 'Candidate count for the latest heartbeat per bounded state', labelNames: ['state'], registers: [register],
});
export const proximityAccumulatorGauge = new client.Gauge({
  name: 'vormex_proximity_accumulator_backlog', help: 'Dirty proximity accumulator backlog', labelNames: ['partition'], registers: [register],
});
export const proximityDegradedCounter = new client.Counter({
  name: 'vormex_proximity_degraded_total', help: 'Crossed Paths degraded-mode responses', labelNames: ['mode'], registers: [register],
});
export const proximitySummaryCounter = new client.Counter({
  name: 'vormex_proximity_summary_total', help: 'Crossed Paths summary outcomes', labelNames: ['outcome'], registers: [register],
});
