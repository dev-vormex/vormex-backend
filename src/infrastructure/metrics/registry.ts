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
