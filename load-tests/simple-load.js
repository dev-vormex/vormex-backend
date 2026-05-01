#!/usr/bin/env node

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 10000;

const scenarios = {
  'health-live': {
    description: 'In-process HTTP liveness check. Good for measuring API/network overhead without database pressure.',
    requiresAuth: false,
    requests: [
      { name: 'health-live', method: 'GET', path: '/api/health/live', weight: 1 },
    ],
  },
  'health-ready': {
    description: 'Readiness check that runs SELECT 1 through Prisma. Good for database connection sanity under load.',
    requiresAuth: false,
    requests: [
      { name: 'health-ready', method: 'GET', path: '/api/health/ready', weight: 1 },
    ],
  },
  'public-read': {
    description: 'Anonymous read mix that exercises feed/discovery-style database reads.',
    requiresAuth: false,
    requests: [
      { name: 'reels-feed', method: 'GET', path: '/api/reels/feed?limit=10', weight: 4 },
      { name: 'people-search', method: 'GET', path: '/api/people?limit=10', weight: 3 },
      { name: 'groups-list', method: 'GET', path: '/api/groups?limit=10', weight: 2 },
      { name: 'jobs-list', method: 'GET', path: '/api/jobs?limit=10', weight: 2 },
      { name: 'health-ready', method: 'GET', path: '/api/health/ready', weight: 1 },
    ],
  },
  'auth-read': {
    description: 'Authenticated read mix for app-home style traffic. Requires LOAD_TEST_TOKEN or --token.',
    requiresAuth: true,
    requests: [
      { name: 'auth-me', method: 'GET', path: '/api/auth/me', weight: 3 },
      { name: 'posts-feed', method: 'GET', path: '/api/posts/feed?limit=10', weight: 4 },
      { name: 'chat-unread', method: 'GET', path: '/api/chat/unread-count', weight: 2 },
      { name: 'notifications-unread', method: 'GET', path: '/api/notifications/unread-count', weight: 2 },
      { name: 'people-suggestions', method: 'GET', path: '/api/people/suggestions?limit=10', weight: 2 },
      { name: 'following-reels', method: 'GET', path: '/api/reels/feed/following?limit=10', weight: 2 },
    ],
  },
};

function printHelp() {
  console.log(`
Vormex backend load-test runner

Usage:
  node load-tests/simple-load.js --scenario health-live --duration 30 --concurrency 20

Options:
  --base-url <url>        API base URL. Default: ${DEFAULT_BASE_URL}
  --scenario <name>       One of: ${Object.keys(scenarios).join(', ')}
  --file <path>           Custom JSON scenario file. Overrides --scenario.
  --duration <seconds>    Test duration. Default: ${DEFAULT_DURATION_SECONDS}
  --concurrency <number>  Number of concurrent workers. Default: ${DEFAULT_CONCURRENCY}
  --timeout <ms>          Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --token <jwt>           Bearer token for authenticated scenarios.
  --tokens <jwt,jwt>      Comma-separated bearer tokens for multi-user tests.
  --max-p95 <ms>          Fail if p95 latency is higher than this value.
  --max-error-rate <pct>  Fail if non-2xx/3xx plus network errors exceed this percent.
  --help                  Show this help.

Environment:
  BASE_URL, LOAD_TEST_TOKEN, LOAD_TEST_TOKENS
`);
}

function parseArgs(argv) {
  const args = {};

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = current.slice(2).split('=', 2);
    const nextValue = argv[index + 1];
    const value = inlineValue !== undefined
      ? inlineValue
      : nextValue && !nextValue.startsWith('--')
        ? nextValue
        : 'true';

    args[rawKey] = value;

    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
  }

  return args;
}

function toPositiveNumber(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return parsed;
}

function readCustomScenario(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const requests = Array.isArray(parsed) ? parsed : parsed.requests;

  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('Custom scenario must be an array or an object with a non-empty "requests" array.');
  }

  return {
    description: parsed.description || `Custom scenario from ${filePath}`,
    requiresAuth: Boolean(parsed.requiresAuth),
    requests,
  };
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('Each request must be an object.');
  }

  if (!request.path && !request.url) {
    throw new Error('Each request must include "path" or "url".');
  }

  return {
    name: request.name || request.path || request.url,
    method: (request.method || 'GET').toUpperCase(),
    path: request.path,
    url: request.url,
    headers: request.headers || {},
    body: request.body,
    auth: request.auth,
    weight: Math.max(1, Number(request.weight || 1)),
  };
}

function expandWeightedRequests(requests) {
  const expanded = [];

  for (const request of requests.map(normalizeRequest)) {
    for (let count = 0; count < request.weight; count += 1) {
      expanded.push(request);
    }
  }

  return expanded;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileValue / 100) * values.length) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)];
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function buildUrl(baseUrl, request) {
  if (request.url) {
    return request.url;
  }

  const base = baseUrl.replace(/\/$/, '');
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
  return `${base}${path}`;
}

function buildBodyAndHeaders(request, token) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'vormex-load-test/1.0',
    ...request.headers,
  };

  let body;
  if (request.body !== undefined) {
    if (typeof request.body === 'string') {
      body = request.body;
    } else {
      body = JSON.stringify(request.body);
      if (!Object.keys(headers).some((header) => header.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
  }

  if (token && request.auth !== false) {
    headers.authorization = `Bearer ${token}`;
  }

  return { body, headers };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createStats() {
  return {
    total: 0,
    failed: 0,
    networkErrors: 0,
    bytes: 0,
    latencies: [],
    statuses: new Map(),
    endpoints: new Map(),
  };
}

function increment(map, key, delta = 1) {
  map.set(key, (map.get(key) || 0) + delta);
}

async function runWorker(workerId, config, stats, deadlineMs) {
  let requestIndex = workerId;

  while (performance.now() < deadlineMs) {
    const request = config.requests[requestIndex % config.requests.length];
    requestIndex += config.concurrency;

    const token = config.tokens.length > 0
      ? config.tokens[(workerId + requestIndex) % config.tokens.length]
      : null;
    const url = buildUrl(config.baseUrl, request);
    const { body, headers } = buildBodyAndHeaders(request, token);
    const startedAt = performance.now();

    try {
      const response = await fetchWithTimeout(url, {
        method: request.method,
        headers,
        body,
      }, config.timeoutMs);
      const buffer = Buffer.from(await response.arrayBuffer());
      const latency = performance.now() - startedAt;

      stats.total += 1;
      stats.bytes += buffer.byteLength;
      stats.latencies.push(latency);
      increment(stats.statuses, String(response.status));
      increment(stats.endpoints, request.name);

      if (response.status < 200 || response.status >= 400) {
        stats.failed += 1;
      }
    } catch (error) {
      const latency = performance.now() - startedAt;

      stats.total += 1;
      stats.failed += 1;
      stats.networkErrors += 1;
      stats.latencies.push(latency);
      increment(stats.statuses, error.name === 'AbortError' ? 'timeout' : 'network-error');
      increment(stats.endpoints, request.name);
    }
  }
}

function printProgress(stats, startMs) {
  const elapsedSeconds = Math.max((performance.now() - startMs) / 1000, 0.001);
  const rps = stats.total / elapsedSeconds;
  const errorRate = stats.total === 0 ? 0 : (stats.failed / stats.total) * 100;

  console.log(
    `[progress] ${Math.floor(elapsedSeconds)}s ` +
    `requests=${stats.total} rps=${formatNumber(rps)} errors=${formatNumber(errorRate)}%`
  );
}

function printSummary(stats, config, elapsedSeconds) {
  const sortedLatencies = stats.latencies.slice().sort((a, b) => a - b);
  const total = stats.total;
  const failed = stats.failed;
  const errorRate = total === 0 ? 0 : (failed / total) * 100;
  const rps = total / Math.max(elapsedSeconds, 0.001);
  const avg = sortedLatencies.reduce((sum, value) => sum + value, 0) / Math.max(sortedLatencies.length, 1);

  const summary = {
    total,
    failed,
    networkErrors: stats.networkErrors,
    errorRate,
    rps,
    bytes: stats.bytes,
    avg,
    min: sortedLatencies[0] || 0,
    p50: percentile(sortedLatencies, 50),
    p90: percentile(sortedLatencies, 90),
    p95: percentile(sortedLatencies, 95),
    p99: percentile(sortedLatencies, 99),
    max: sortedLatencies[sortedLatencies.length - 1] || 0,
  };

  console.log('\nSummary');
  console.log(`  Scenario:       ${config.scenarioName}`);
  console.log(`  Duration:       ${formatNumber(elapsedSeconds)}s`);
  console.log(`  Concurrency:    ${config.concurrency}`);
  console.log(`  Requests:       ${summary.total}`);
  console.log(`  Throughput:     ${formatNumber(summary.rps)} req/s`);
  console.log(`  Failed:         ${summary.failed} (${formatNumber(summary.errorRate)}%)`);
  console.log(`  Network errors: ${summary.networkErrors}`);
  console.log(`  Bytes read:     ${summary.bytes}`);
  console.log('  Latency ms:');
  console.log(`    avg=${formatNumber(summary.avg)} min=${formatNumber(summary.min)} p50=${formatNumber(summary.p50)} p90=${formatNumber(summary.p90)} p95=${formatNumber(summary.p95)} p99=${formatNumber(summary.p99)} max=${formatNumber(summary.max)}`);

  console.log('\nStatus counts');
  for (const [status, count] of [...stats.statuses.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    console.log(`  ${status}: ${count}`);
  }

  console.log('\nEndpoint counts');
  for (const [endpoint, count] of [...stats.endpoints.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${endpoint}: ${count}`);
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const scenarioName = args.file ? args.file : (args.scenario || 'health-live');
  const scenario = args.file
    ? readCustomScenario(args.file)
    : scenarios[scenarioName];

  if (!scenario) {
    throw new Error(`Unknown scenario "${scenarioName}". Use --help to list scenarios.`);
  }

  const tokens = [
    ...(args.tokens || process.env.LOAD_TEST_TOKENS || '').split(','),
    args.token || process.env.LOAD_TEST_TOKEN || '',
  ]
    .map((token) => token.trim())
    .filter(Boolean);

  if (scenario.requiresAuth && tokens.length === 0) {
    throw new Error(`Scenario "${scenarioName}" requires --token or LOAD_TEST_TOKEN.`);
  }

  const config = {
    scenarioName,
    baseUrl: args['base-url'] || DEFAULT_BASE_URL,
    durationSeconds: toPositiveNumber(args.duration, DEFAULT_DURATION_SECONDS, '--duration'),
    concurrency: Math.floor(toPositiveNumber(args.concurrency, DEFAULT_CONCURRENCY, '--concurrency')),
    timeoutMs: toPositiveNumber(args.timeout, DEFAULT_TIMEOUT_MS, '--timeout'),
    maxP95: args['max-p95'] === undefined ? null : toPositiveNumber(args['max-p95'], null, '--max-p95'),
    maxErrorRate: args['max-error-rate'] === undefined
      ? null
      : toPositiveNumber(args['max-error-rate'], null, '--max-error-rate'),
    tokens,
    requests: expandWeightedRequests(scenario.requests),
  };

  console.log('Vormex backend load test');
  console.log(`  Base URL:    ${config.baseUrl}`);
  console.log(`  Scenario:    ${config.scenarioName}`);
  console.log(`  Description: ${scenario.description}`);
  console.log(`  Duration:    ${config.durationSeconds}s`);
  console.log(`  Concurrency: ${config.concurrency}`);
  console.log(`  Timeout:     ${config.timeoutMs}ms`);
  console.log(`  Auth tokens: ${config.tokens.length}`);
  console.log('');

  const stats = createStats();
  const startMs = performance.now();
  const deadlineMs = startMs + (config.durationSeconds * 1000);
  const progressTimer = setInterval(() => printProgress(stats, startMs), 5000);
  const workers = [];

  for (let workerId = 0; workerId < config.concurrency; workerId += 1) {
    workers.push(runWorker(workerId, config, stats, deadlineMs));
  }

  await Promise.all(workers);
  clearInterval(progressTimer);

  const elapsedSeconds = (performance.now() - startMs) / 1000;
  const summary = printSummary(stats, config, elapsedSeconds);

  const thresholdFailures = [];
  if (config.maxP95 !== null && summary.p95 > config.maxP95) {
    thresholdFailures.push(`p95 ${formatNumber(summary.p95)}ms > ${formatNumber(config.maxP95)}ms`);
  }
  if (config.maxErrorRate !== null && summary.errorRate > config.maxErrorRate) {
    thresholdFailures.push(`error rate ${formatNumber(summary.errorRate)}% > ${formatNumber(config.maxErrorRate)}%`);
  }

  if (thresholdFailures.length > 0) {
    console.error(`\nThresholds failed: ${thresholdFailures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Load test failed: ${error.message}`);
  process.exitCode = 1;
});
