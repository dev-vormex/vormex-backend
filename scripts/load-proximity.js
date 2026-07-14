'use strict';

const { randomUUID } = require('node:crypto');

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const tokens = String(process.env.PROXIMITY_TEST_TOKENS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const rounds = Math.max(1, Number(process.env.PROXIMITY_ROUNDS || 10));
const venueLatitude = Number(process.env.PROXIMITY_VENUE_LATITUDE || 12.9716);
const venueLongitude = Number(process.env.PROXIMITY_VENUE_LONGITUDE || 77.5946);

if (tokens.length === 0) {
  console.error('Set PROXIMITY_TEST_TOKENS to comma-separated development-account access tokens.');
  process.exit(1);
}

async function request(token, method, path, body) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/proximity/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-vormex-install-id': `proximity-load-${token.slice(-8)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, elapsedMs: performance.now() - startedAt };
}

function sample(index, sampleId = randomUUID()) {
  const angle = (index % 32) * Math.PI / 16;
  const distanceM = (index % 10) * 8;
  return {
    sampleId,
    capturedAt: new Date().toISOString(),
    latitude: venueLatitude + (distanceM * Math.cos(angle)) / 111_320,
    longitude: venueLongitude + (distanceM * Math.sin(angle)) / (111_320 * Math.cos(venueLatitude * Math.PI / 180)),
    accuracyM: 20,
  };
}

async function main() {
  const sessions = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    await request(token, 'PUT', '/settings', { crossedPathsDiscoverable: true });
    const started = await request(token, 'POST', '/sessions', {
      clientStartId: randomUUID(),
      radiusM: 500,
      ...sample(index),
    });
    if (started.status !== 201) throw new Error(`Session start failed (${started.status}): ${JSON.stringify(started.payload)}`);
    sessions.push({ token, sessionId: started.payload.data.sessionId, generation: started.payload.data.generation, sequence: 1 });
  }

  const latencies = [];
  const statuses = new Map();
  for (let round = 0; round < rounds; round += 1) {
    const results = await Promise.all(sessions.map(async (session, index) => {
      session.sequence += 1;
      const heartbeat = await request(session.token, 'POST', `/sessions/${session.sessionId}/heartbeat`, {
        sessionId: session.sessionId,
        generation: session.generation,
        sequence: session.sequence,
        ...sample(index + round),
      });
      if (round % 3 === 0) await request(session.token, 'GET', '/live?radiusM=500');
      return heartbeat;
    }));
    for (const result of results) {
      latencies.push(result.elapsedMs);
      statuses.set(result.status, (statuses.get(result.status) || 0) + 1);
    }
  }

  await Promise.all(sessions.map((session) => request(session.token, 'POST', `/sessions/${session.sessionId}/stop`)));
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  console.log(JSON.stringify({
    sessions: sessions.length,
    heartbeats: latencies.length,
    statusCounts: Object.fromEntries(statuses),
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
