# Phase 3: production cache and cold-path control

Phase 3 closes the gap between the fast single-process localhost results from
Phase 2 and a multi-instance production deployment. Redis remains private
backend infrastructure. Android and web consume ordinary HTTPS responses and
must never receive Redis URLs or credentials.

## Tasks

- [x] Bound the backend in-process fallback cache and remove expired tag links.
- [x] Keep Redis tag-index TTLs at least as long as their longest cache member.
- [x] Coalesce simultaneous cold core/full profile reads in one process and
  across API instances through the cache lock.
- [x] Move automatic profile-view analytics off the API database pool and onto
  the critical Redis analytics queue.
- [x] De-duplicate repeated viewer/target analytics jobs in five-minute windows.
- [x] Add cache namespace/backend/outcome counters and cache-operation latency.
- [x] Include follow state in the core profile relationship context.
- [x] Remove Android's follow-status request after the core profile response.
- [x] Hydrate web relationship controls from the core response.
- [x] Fetch web mutual-relationship details only when that section approaches
  the viewport.
- [x] Store web profile responses under requested, ID, username, and `@username`
  query aliases.
- [x] Add automated Phase 3 regression tests.

## Performance budgets

- A burst of concurrent requests for the same viewer/profile/cache kind
  performs one compute per cache key.
- A Redis tag index never expires before any cache entry added to that tag.
- The optional in-process fallback holds at most
  `CACHE_MEMORY_MAX_ENTRIES` entries (default 1000).
- Automatic profile-view tracking performs zero Prisma queries in the API
  process.
- At most one automatic profile-view job is accepted per viewer/target pair
  during each five-minute window.
- Cache metrics use a bounded namespace allow-list; cache keys and user IDs are
  never Prometheus labels.
- The core profile contains connection and follow state, eliminating Android's
  follow lookup and web's connection/follow mount requests.
- Web mutual details produce no request until their section nears the viewport.
- Redis credentials are present only in backend/API/worker configuration.

## Test cases

1. Cache metric namespaces map arbitrary keys to a fixed allow-list.
2. The fallback cache evicts its least-recently-used entry at its configured
   bound.
3. Removing or expiring a fallback entry also removes its tag-index links.
4. Redis tag registration uses `NX` plus `GT` expiry semantics so a shorter
   member cannot shorten an existing tag TTL.
5. Profile core and bundle reads use cache single-flight coordination.
6. Core profile serialization includes `isFollowing` and `isFollowedBy`.
7. Automatic profile tracking queues analytics instead of calling the
   social-proof database service from the API.
8. Profile-view job IDs are stable inside a five-minute window and change
   across windows.
9. The analytics worker handles a profile-view payload and rejects malformed
   identifiers.
10. Cache outcome and duration metrics include bounded namespace/backend labels.
11. Web relationship controls initialize from `viewerContext` without
    connection/follow mount calls.
12. Web mutual info uses viewport-triggered loading.
13. Web caches requested, UUID, username, and `@username` aliases.
14. Android does not call `getFollowStatus` after a successful core response.
15. Backend, web, and Android regression suites and production builds remain
    green.

## Local and production validation

Local validation exercises the bounded memory fallback because no local Redis
server is installed. A production rollout must separately prove:

1. critical and cache Redis report `connected`;
2. API, worker, and scheduler heartbeats stay healthy for at least 15 minutes;
3. cache hit ratio and Redis command p95 remain within the alert budgets;
4. the analytics queue stays near zero backlog;
5. profile HTTP p95/p99 improve without database connection saturation.

Do not enable the historical outbox backlog as part of this phase. It remains a
separate, deliberately throttled production operation.

## Local results (2026-07-26)

- Backend liveness: HTTP 200.
- Web-proxied backend liveness: HTTP 200.
- Twelve concurrent cold requests for one uncached public core profile: all
  HTTP 200 in 564.6 ms total wall time.
- Five following warm core requests: 16.4 ms average, 22.4 ms maximum.
- Memory single-flight unit test: twelve callers, one compute.
- The consolidated connection/follow SQL was executed read-only against two
  existing users and returned one row with both follow flags as booleans.
- Backend: 261 tests passed.
- Web: 28 tests passed and the 71-route production build completed.
- Android: 125 tests passed and debug Kotlin compilation completed.

The localhost metrics endpoint intentionally requires an authenticated admin
in addition to the IP allow-list, so anonymous benchmark scripts cannot read
the counter delta. Production metric collection must use the configured admin
scrape identity.
