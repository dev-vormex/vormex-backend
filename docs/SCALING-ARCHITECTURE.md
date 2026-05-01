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
