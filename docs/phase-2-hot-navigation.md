# Phase 2: instant hot navigation

Phase 2 makes a profile usable before its heavy sections finish loading. It
applies the same pattern used by large social apps: render cached summary data,
refresh it in the background, and fetch expensive lower-page sections only
after the first screen is visible.

## Tasks

- [x] Check profile caches by requested username/ID before a database lookup.
- [x] Store viewer-scoped username and ID aliases with the same invalidation tag.
- [x] Remove per-open post/follower/connection recount queries from the full bundle.
- [x] Defer profile-view analytics outside response latency.
- [x] Give Android a bounded 32-profile in-memory LRU above its disk cache.
- [x] Encode Android ID/username cache aliases once per profile response.
- [x] Coalesce Android navigation prefetch and screen loading into one request.
- [x] Cover every Android profile entry point through the shared navigation state.
- [x] Remove the artificial 900 ms Android content hold.
- [x] Make web profile navigation load core header/stats before `include=all`.
- [x] Prefetch web route code and core data only on pointer, focus, or touch intent.
- [x] Apply intent-prefetch to posts, people, reels, chat, and network lists.

## Performance budgets

- A warm backend core-profile hit performs zero profile database queries.
- Android issues at most one in-flight core request per viewer/profile pair.
- Android memory cache remains bounded to 32 profile responses.
- Web must call the core endpoint and clear the blocking loader before requesting the full bundle.
- Web list rendering must not automatically prefetch every profile.
- Profile mutations and relationship mutations invalidate every username/ID alias through `user:<id>` tags.
- Heavy profile sections may fail without hiding an already rendered core profile.

## Test cases

1. Profile identifiers normalize `@Username`, username, and UUID forms.
2. Viewer identity remains part of every profile cache key.
3. Core/full cache lookup occurs before `prisma.user.findFirst`.
4. The full bundle contains no per-open post/follow/connection recount.
5. Profile-view analytics use deferred execution.
6. Android LRU evicts the least recently used entry at 32 entries.
7. Android stale memory entries are discarded.
8. Android profile requests are single-flight and scoped by viewer and bundle type.
9. Android renders the response without an artificial delay.
10. Web materializes a render-safe core profile with empty deferred sections.
11. Web clears its blocking loader before starting the full bundle request.
12. Web intent-prefetch has no mount-time `useEffect` request storm.

## Measurement

Measure both cold and warm navigation through the direct backend and the web
proxy. The key Phase 2 metric is time to visible profile header, not time until
every lower-page section has finished downloading. Production p95 measurement
still requires the Phase 1 Redis and Singapore deployment rollout.

Local validation on 2026-07-26 used five requests against four separate public
profiles. The first request is cold; the warm result is the average of requests
two through five.

| Path | Cold | Warm average | Warm max |
| --- | ---: | ---: | ---: |
| Backend core (`localhost:5000`) | 559.9 ms | 14.3 ms | 14.9 ms |
| Web-proxied core (`localhost:3000`) | 560.5 ms | 24.3 ms | 28.4 ms |
| Backend full bundle | 2022.6 ms | 25.5 ms | 28.6 ms |
| Web-proxied full bundle | 1648.3 ms | 33.2 ms | 44.8 ms |

All 20 responses returned HTTP 200. These localhost figures validate the cache
shape and proxy overhead; they are not a substitute for production p95/p99
telemetry under concurrent traffic.
