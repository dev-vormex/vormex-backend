# Strict Queue-Based Scalability

## Runtime Topology

```text
Web / Android
  -> CDN / WAF
  -> NGINX
  -> API replicas (Express + Socket.IO + Redis adapter)
     -> Postgres primary / read replica
     -> Redis
  -> Worker replicas (BullMQ processors + outbox dispatch)
  -> Scheduler (repeatable jobs only)
```

## Queue Map

- `realtime_fanout`: Socket fanout envelopes published through Redis
- `notification_delivery`: Push notifications and user-facing async delivery
- `cache_invalidation`: Tag-based cache invalidation
- `analytics_events`: Reserved for async product analytics
- `media_processing`: Reserved for asset finalization and media pipelines
- `scheduled_publish`: Scheduled reel publication
- `people_you_know`: Pending joined-contact flushes
- `maintenance`: Outbox dispatcher tick and general background maintenance

## Reels Publishing Contract

Android and web publish reels through `POST /api/reels` as multipart form data.

Required:

- `video`: MP4/MOV/WebM video file, capped at 150 MB by the route middleware

Optional posting fields:

- `thumbnail`: image file for the reel poster
- `title`, `caption`
- `hashtags`: JSON string array
- `mentions`, `skills`, `topics`: JSON string arrays
- `category`
- `visibility`: `public`, `connections`, or `private`
- `allowComments`, `allowDuets`, `allowStitch`, `allowDownload`, `allowSharing`
- `saveAsDraft`
- `scheduledAt`
- `audioId`, `audioStartTime`, `muteOriginalAudio`
- `originalReelId`, `responseType` for duet/stitch flows
- `codeSnippet`, `codeLanguage`, `codeFileName`, `repoUrl`

Publication states:

- `draft`: creator saved it without publishing
- `processing`: Bunny Stream accepted the video and transcoding is still running
- `ready`: video is playable and eligible for feeds

## Reels Ranking

Feed eligibility starts with `status = ready`, `visibility = public`, and `publishedAt != null`.

- Following feed: stays chronological for predictability.
- For You feed: reranks the current pagination window by freshness, watch quality, engagement, and new-creator discovery.

For You signals:

- Freshness: decays as the reel gets older.
- Watch quality: `avgWatchTimeMs / durationSeconds` and `completionRate`.
- Engagement: shares and saves weigh highest, then comments, then likes.
- Discovery boost: small boost for low-view reels published in the last 24 hours.

`POST /api/reels/:reelId/view` batches watch events and refreshes `viewsCount`, `uniqueViewsCount`, `avgWatchTimeMs`, and `completionRate`, which feed the ranking score.

## Core Rules

- API request handlers only do validation, auth, primary database writes, and outbox inserts.
- Workers own side effects: push delivery, realtime fanout, cache invalidation, and recurring jobs.
- Scheduler is the only process that registers repeatable jobs.
- Socket.IO rooms are horizontally safe via the Redis adapter.

## Abuse Protection

The API uses Redis-backed fixed-window limits so every API replica shares the same counters. Local development can fall back to in-memory counters, but production requires Redis.

Protection layers:

- Global `/api` limiter: per-IP, per-fingerprint, per-user, write-specific, anonymous sustained, and read-heavy buckets.
- Bot guard: blocks high-confidence scanner user agents and applies stricter limits to script-like or missing user agents.
- Auth limiter: login, account creation, OAuth, password reset, and email verification have identifier-specific and IP-specific windows.
- Payment limiter: premium checkout, verify, and cancel writes use sensitive action buckets per user and IP.
- AI limiter: AI helper, career chat, and agent routes use the same sensitive posture as payment routes with burst and hourly user/IP windows.
- Firebase App Check: Android sends `X-Firebase-AppCheck`; the backend verifies it when Firebase Admin is configured. `APP_CHECK_ENFORCEMENT=monitor` observes tokens without blocking; `sensitive` enforces on AI/payment-style endpoints; `all` enforces every API request.

Rate-limit responses return HTTP `429`, `Retry-After`, `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, `code`, `requestId`, and `retryAfterSeconds`. Android surfaces the cooldown to users and sends `VormexAndroid/{version}` plus app-version headers on every API call.

## Hot Cache Keys

- `profile:bundle:{viewer}:{target}`
- `profile:feed:{userId}:{filter}:{page}:{limit}`
- `reels:feed:public:{query}`
- `people:public:{query}`
- `notifications:unread:{userId}`
- `auth:session:{sessionId}`
- `rate:*`
- `ai:rate-limit:*`
- `app-check:{tokenHash}`

## Tag Invalidation

- `user:{userId}`
- `feed:{userId}`
- `reels:feed`
- `people:public`
- `conversation:{conversationId}`
- `notifications:{userId}`

## Production Requirements

- `NODE_ENV=production` requires `DATABASE_URL`, `JWT_SECRET`, `AUTH_CSRF_SECRET`, and `REDIS_URL`.
- Keep `REDIS_REQUIRED=true` in production; otherwise rate limits become per-process and will not protect a horizontally scaled deployment.
- Tune `RATE_LIMIT_*` environment variables in staging before changing production thresholds.
- Start App Check in `monitor`, then move to `sensitive` after Android release adoption is healthy. Do not use `all` until web clients also send valid app attestation or have their own enforcement path.
- `/api/health/live` only proves the HTTP process is alive.
- `/api/health/ready` proves Postgres is reachable and Redis is healthy; production deployments should use this as the health check.
- `TRUST_PROXY` should match the deployment edge. The default production value trusts one proxy hop.
- `WORKER_CONCURRENCY` controls BullMQ concurrency per worker process. Raise it only while watching Redis, Postgres, and push-provider limits.
- API replicas, workers, and the scheduler must use the same `DATABASE_URL`, `REDIS_URL`, JWT, CSRF, Firebase, and upload-provider secrets.

## Capacity Gates

Before increasing traffic, run the load tests from `load-tests/README.md` against staging with production-sized Postgres and Redis:

- `health-live`: should stay low-latency with no errors; this measures raw API overhead.
- `health-ready`: should stay stable; this catches database or Redis readiness pressure.
- `public-read`: should keep p95 below the launch target after caches warm.
- `auth-read`: must use multiple staging users/tokens so the test measures backend capacity instead of one user's rate limit.

## Runbook

1. Start Redis and Postgres.
2. Run backend API replicas behind NGINX.
3. Run at least one worker replica.
4. Run exactly one scheduler replica.
5. Monitor `/api/health/live`, `/api/health/ready`, and `/metrics`.
