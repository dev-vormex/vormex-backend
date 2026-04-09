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

## Core Rules

- API request handlers only do validation, auth, primary database writes, and outbox inserts.
- Workers own side effects: push delivery, realtime fanout, cache invalidation, and recurring jobs.
- Scheduler is the only process that registers repeatable jobs.
- Socket.IO rooms are horizontally safe via the Redis adapter.

## Hot Cache Keys

- `profile:bundle:{viewer}:{target}`
- `profile:feed:{userId}:{filter}:{page}:{limit}`
- `notifications:unread:{userId}`
- `auth:session:{sessionId}`

## Tag Invalidation

- `user:{userId}`
- `feed:{userId}`
- `conversation:{conversationId}`
- `notifications:{userId}`

## Runbook

1. Start Redis and Postgres.
2. Run backend API replicas behind NGINX.
3. Run at least one worker replica.
4. Run exactly one scheduler replica.
5. Monitor `/api/health/live`, `/api/health/ready`, and `/metrics`.
