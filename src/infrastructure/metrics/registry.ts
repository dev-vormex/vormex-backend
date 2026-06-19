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

export const dbConnectionGauge = new client.Gauge({
  name: 'vormex_db_connections',
  help: 'Postgres connections visible to the current database, grouped by connection state',
  labelNames: ['state'],
  registers: [register],
});
