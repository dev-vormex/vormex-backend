# Phase 4: Daily Feed Snapshots

## Outcome

The web feed now paints the last successful user-scoped result immediately after a reload. The backend ranks posts through the existing unified recommendation algorithm and stores the result in Redis under a 24-hour snapshot window. Stories, smart matches, and daily matches use the same daily-window contract.

The Redis entries live for up to 48 hours so an entry cannot disappear near a window boundary, but the window number is part of every key. A new 24-hour window therefore creates a fresh ranking even if the previous physical key still exists.

## Completed tasks

- [x] Stop normal browser `Cache-Control: no-cache` headers from bypassing application Redis.
- [x] Keep explicit support-only refresh controls: `cacheBust`, `_t`, and `X-Vormex-Feed-Refresh: true`.
- [x] Bound unified feed candidate work instead of loading 500 posts on every cold request.
- [x] Coalesce simultaneous cold requests with a distributed Redis lock.
- [x] Persist up to three successful feed pages in user-scoped browser storage for immediate reload paint.
- [x] Increase only the feed request timeout to 30 seconds and retry initial transient failures twice.
- [x] Keep cached posts visible if a background refresh fails.
- [x] Cache recommendation preferences, block lists, ad inputs, stories, daily matches, and smart matches.
- [x] Prune expired stories both before browser paint and before cached server responses.
- [x] Clear browser snapshots on logout or invalid authentication.
- [x] Prevent likes, comments, votes, shares, and saves from evicting every user's feed snapshot.
- [x] Preserve global invalidation for edits, deletes, and collaboration changes that alter visible content.

## Required production configuration

Use separate Redis roles in production when possible:

```env
CRITICAL_REDIS_URL=rediss://...
CACHE_REDIS_URL=rediss://...
CRITICAL_REDIS_REQUIRED=true
CACHE_REDIS_REQUIRED=true
```

`REDIS_URL` remains a local/legacy fallback. Without a cache Redis URL, the application uses a bounded per-process memory fallback; that helps locally but cannot share snapshots between production instances.

Run the API, worker, and scheduler services from the same release. Cache invalidation fan-out for new posts depends on the worker.

## Verification

1. Sign in on the web and open `/feed` with DevTools Network recording.
2. Confirm `GET /posts/feed` returns `200`, `X-Vormex-Cache: SNAPSHOT`, and an `X-Vormex-Feed-Window` value.
3. Reload the page. Existing posts, stories, people, and matches should paint immediately without the full skeleton or timeout panel.
4. Confirm the feed request continues in the background and does not erase visible posts if it is temporarily unavailable.
5. Reload several times. `X-Vormex-Feed-Window`, post order, story order, and daily-match order should remain stable.
6. Create or delete a post and confirm the relevant feed updates. Like/comment/share activity must not cause an application-wide cold feed.
7. Advance to the next 24-hour window or clear the user-scoped browser cache, then confirm the server supplies a new snapshot window.

Automated checks:

```powershell
# Backend
node node_modules/typescript/bin/tsc -p tsconfig.json
node --test dist/tests/*.test.js

# Web
npm test
npm run build
```
