# Redis Caching Guide

**Status: Planned for Future Implementation**

This document outlines the planned Redis caching strategy for the Vormex API.

## Overview

Redis caching will be implemented to:
- Reduce database load
- Improve API response times
- Implement rate limiting
- Cache frequently accessed data

## Planned Features

### 1. Response Caching

Cache API responses for:
- User profiles (5 minutes)
- Activity heatmaps (24 hours)
- GitHub stats (1 hour)
- Skills search (1 hour)
- User feeds (5 minutes)

### 2. Rate Limiting

Implement rate limits per user/IP:
- Authentication: 5 requests/minute
- GitHub sync: 1 request/hour
- General API: 100 requests/minute

### 3. Session Management

- Store JWT refresh tokens
- Track active sessions
- Implement session invalidation

## Implementation Plan

### Phase 1: Basic Caching

```typescript
// Cache user profiles
const cacheKey = `user:profile:${userId}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);

const profile = await getProfile(userId);
await redis.setex(cacheKey, 300, JSON.stringify(profile)); // 5 min
return profile;
```

### Phase 2: Rate Limiting

```typescript
// Rate limit middleware
const key = `ratelimit:${userId}:${endpoint}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 60); // 1 minute window
if (count > limit) throw new Error('Rate limit exceeded');
```

### Phase 3: Advanced Features

- Cache invalidation on updates
- Distributed caching
- Cache warming
- Cache analytics

## Cache Keys Structure

```
vormex:user:profile:{userId}
vormex:activity:heatmap:{userId}:{year}
vormex:github:stats:{userId}
vormex:skills:search:{query}
vormex:feed:{userId}:{page}:{filter}
vormex:ratelimit:{userId}:{endpoint}
vormex:session:{userId}
```

## Configuration

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_TTL_PROFILE=300
REDIS_TTL_ACTIVITY=86400
REDIS_TTL_GITHUB=3600
```

## Benefits

1. **Performance**: 10-100x faster responses for cached data
2. **Scalability**: Reduce database load by 80%+
3. **Cost**: Lower database costs
4. **User Experience**: Faster page loads

## Timeline

- **Q1 2025**: Basic caching implementation
- **Q2 2025**: Rate limiting
- **Q3 2025**: Advanced features

## Notes

This is a planned feature. Current implementation does not include Redis caching. All endpoints query the database directly.

For now, consider:
- Frontend caching
- HTTP caching headers
- Database query optimization

