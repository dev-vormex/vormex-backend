#!/usr/bin/env node

const { performance } = require('node:perf_hooks');

const baseUrl = String(process.env.RECOMMENDATION_LOAD_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = String(process.env.RECOMMENDATION_LOAD_TOKEN || '').trim();
const durationSeconds = Math.max(10, Number(process.env.RECOMMENDATION_LOAD_DURATION_SECONDS || 60));
const concurrency = Math.max(1, Math.min(100, Number(process.env.RECOMMENDATION_LOAD_CONCURRENCY || 10)));

if (!token) {
  console.error('RECOMMENDATION_LOAD_TOKEN is required. Use a non-production test account token.');
  process.exit(2);
}

const latencies = [];
let requests = 0;
let errors = 0;
let paginationFailures = 0;
const deadline = Date.now() + durationSeconds * 1000;

async function request(path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Vormex-Load-Test': 'recommendations-v1' },
  });
  latencies.push(performance.now() - started);
  requests += 1;
  if (!response.ok) {
    errors += 1;
    await response.text();
    return null;
  }
  return response.json();
}

async function exerciseStableHomeSession() {
  const first = await request('/api/posts/feed?mode=recommended&limit=40');
  if (!first) return;
  if (!first.nextCursor || !first.recommendationSessionId) return;
  const second = await request(`/api/posts/feed?mode=recommended&limit=40&cursor=${encodeURIComponent(first.nextCursor)}`);
  if (!second) return;
  const firstIds = new Set((first.posts || []).map((post) => post.id));
  const overlap = (second.posts || []).some((post) => firstIds.has(post.id));
  if (second.recommendationSessionId !== first.recommendationSessionId || overlap) paginationFailures += 1;
}

async function worker(index) {
  while (Date.now() < deadline) {
    if (index % 3 === 0) await exerciseStableHomeSession();
    else if (index % 3 === 1) await request('/api/reels/feed?mode=foryou&limit=20');
    else await request('/api/jobs/recommended?limit=20');
  }
}

function percentile(values, probability) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
}

Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)))
  .then(() => {
    const p95 = percentile(latencies, 0.95);
    const errorRate = requests > 0 ? errors / requests : 1;
    console.log(JSON.stringify({
      baseUrl, durationSeconds, concurrency, requests, errors,
      errorRate: Number(errorRate.toFixed(4)), p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
      p95Ms: Number(p95.toFixed(1)), paginationFailures,
    }, null, 2));
    if (errorRate >= 0.01 || p95 > 500 || paginationFailures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
