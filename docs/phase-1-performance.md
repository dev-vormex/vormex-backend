# Phase 1: local speed and backend resilience

Phase 1 makes local Android and web development deterministic and prevents the
background infrastructure from silently failing or replaying unsafe historical
work. Redis remains a backend concern; Android and web never connect to Redis.

## Local implementation tasks

- [x] Android debug API and Socket.IO default to `http://localhost:5000`.
- [x] Android release builds retain the production HTTPS endpoints.
- [x] Web REST stays same-origin at `/api` and proxies to `localhost:5000`.
- [x] Web Socket.IO defaults to `http://localhost:5000`.
- [x] Split critical Redis from evictable cache Redis with a `REDIS_URL` local fallback.
- [x] Move sessions, BullMQ, realtime coordination, presence, and heartbeats to critical Redis.
- [x] Keep application/feed caches on cache Redis.
- [x] Publish worker and scheduler heartbeats and include them in API readiness.
- [x] Keep outbox dispatch disabled by default and reduce its default tick rate to 30 seconds.
- [x] Expire stale realtime, notification, cache, and analytics outbox work.
- [x] Preserve durable side effects and quarantine unknown historical work.
- [x] Add automated Phase 1 regression tests.

## Automated test cases

1. Role resolution uses distinct `CRITICAL_REDIS_URL` and `CACHE_REDIS_URL` values.
2. A local `REDIS_URL` still supports both roles without extra setup.
3. Auth sessions use the critical store; normal caches use the cache store.
4. Queues require critical Redis.
5. Worker/scheduler pulses classify as healthy, stale, missing, or unavailable.
6. `/api/health/ready` fails when required background processes are unhealthy.
7. Fresh ephemeral outbox work dispatches.
8. Old realtime, push, cache, and analytics work expires without reaching BullMQ.
9. Old durable connection/media/scheduled work remains dispatchable.
10. Old unclassified work is quarantined instead of guessed or deleted.
11. Web local REST proxy and Socket.IO resolve to port 5000.
12. Production URL overrides still replace web local defaults.
13. Backend TypeScript build and all existing regression tests stay green.
14. Android debug compilation/tests and web build/tests stay green.

## Local runbook

Run the backend on port 5000:

```powershell
cd D:\VORMEX\vormex-backend
npm run dev:server
```

Run the web app:

```powershell
cd D:\VORMEX\vormex-web
npm run dev
```

For a physical Android device, map its localhost port before launching the debug app:

```powershell
adb reverse tcp:5000 tcp:5000
```

An emulator can override the Gradle debug URLs with `http://10.0.2.2:5000`.

Local Redis is optional for API-only UI work. To exercise workers and schedulers,
run Redis on port 6379, set `DEV_BACKGROUND_JOBS=true`, and start all backend
processes with `npm run dev`.

## Production rollout tasks (after local sign-off)

- [ ] Rotate the database credentials that previously appeared in the tracked example file and repository history.
- [ ] Provision critical Redis with persistence and `noeviction`.
- [ ] Provision a separate cache Redis with an explicit memory limit and eviction policy.
- [ ] Set both role URLs on the API and worker; set critical Redis on the scheduler.
- [ ] Deploy API, worker, and scheduler in Singapore beside the database.
- [ ] Verify both background heartbeats in `/api/health/ready` for at least 15 minutes.
- [ ] Inspect and count `expired`, `quarantined`, and durable pending outbox rows.
- [ ] Enable `OUTBOX_DISPATCH_ENABLED=true` with batch size 5 and a 30-second interval.
- [ ] Watch database pool saturation, queue backlog, outbox counters, and p95 latency before increasing throughput.
- [ ] Repair the `api.vormex.in` DNS/TLS route before moving clients away from the current production origin.

Do not enable historical outbox dispatch until the two Redis roles, worker, and
scheduler heartbeats are healthy. Never add Redis credentials to either client.
