# Profile API Guide

Complete guide to the Vormex Profile API.

## Overview

The Profile API allows you to:
- View user profiles (public, respects privacy settings)
- Update your own profile
- Upload avatar and banner images
- Get user content feeds

## Endpoints

### Get User Profile

**GET** `/api/users/{username}/profile`

Get full user profile with all data.

**Parameters:**
- `username` (path) - User's username

**Headers:**
- `Authorization: Bearer <token>` (optional, but recommended for full data)

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "username": "johndoe",
    "name": "John Doe",
    "avatar": "https://cdn.bunny.net/...",
    "bannerImageUrl": "https://cdn.bunny.net/...",
    "headline": "Software Engineering Student",
    "bio": "Passionate about building great products",
    "location": "Vellore, India",
    "college": "VIT Vellore",
    "degree": "B.Tech",
    "branch": "Computer Science",
    "currentYear": 3,
    "graduationYear": 2025,
    "portfolioUrl": "https://johndoe.dev",
    "linkedinUrl": "https://linkedin.com/in/johndoe",
    "githubProfileUrl": "https://github.com/johndoe",
    "isOpenToOpportunities": true,
    "profileVisibility": "PUBLIC",
    "verified": true,
    "interests": ["Web Development", "Machine Learning"]
  },
  "stats": {
    "xp": 1250,
    "level": 5,
    "xpToNextLevel": 250,
    "totalPosts": 45,
    "totalArticles": 12,
    "currentStreak": 7,
    "longestStreak": 30
  },
  "github": {
    "connected": true,
    "username": "johndoe",
    "stats": {
      "totalContributions": 487,
      "repositories": 23,
      "stars": 156
    }
  },
  "activityHeatmap": [
    {
      "date": "2024-01-01",
      "activityCount": 5,
      "isActive": true,
      "level": 2
    },
    ...
  ],
  "skills": [...],
  "experiences": [...],
  "education": [...],
  "projects": [...],
  "certificates": [...],
  "achievements": [...]
}
```

**Privacy Settings:**
- `PUBLIC`: Anyone can view
- `STUDENTS_ONLY`: Only verified students
- `CONNECTIONS`: Only connected users

**Error Responses:**
- `403`: Profile is private
- `404`: User not found

### Update Profile

**PUT** `/api/users/me`

Update your own profile information.

**Headers:**
- `Authorization: Bearer <token>` (required)

**Request Body:**
```json
{
  "headline": "Software Engineering Student",
  "bio": "Passionate about building great products",
  "location": "Vellore, India",
  "currentYear": 3,
  "degree": "B.Tech",
  "graduationYear": 2025,
  "portfolioUrl": "https://johndoe.dev",
  "linkedinUrl": "https://linkedin.com/in/johndoe",
  "githubProfileUrl": "https://github.com/johndoe",
  "profileVisibility": "PUBLIC"
}
```

**Validation:**
- `headline`: Max 120 characters
- `bio`: Max 500 characters
- `currentYear`: 1-5
- `profileVisibility`: `PUBLIC`, `STUDENTS_ONLY`, or `CONNECTIONS`
- URLs must be valid

**Response:**
```json
{
  "id": "uuid",
  "username": "johndoe",
  "name": "John Doe",
  ...
}
```

### Upload Avatar

**POST** `/api/users/me/avatar`

Update profile avatar image.

**Headers:**
- `Authorization: Bearer <token>` (required)
- `Content-Type: application/json`

**Request Body:**
```json
{
  "avatarUrl": "https://storage.bunnycdn.com/vormex/avatars/user-id.jpg"
}
```

**Note:** Upload file to Bunny.net first, then send CDN URL to this endpoint.

**Response:**
```json
{
  "avatar": "https://storage.bunnycdn.com/vormex/avatars/user-id.jpg"
}
```

### Upload Banner

**POST** `/api/users/me/banner`

Update profile banner image.

**Headers:**
- `Authorization: Bearer <token>` (required)
- `Content-Type: application/json`

**Request Body:**
```json
{
  "bannerUrl": "https://storage.bunnycdn.com/vormex/banners/user-id.jpg"
}
```

**Recommended Dimensions:**
- Banner: 1500x500px
- Avatar: 400x400px

**Response:**
```json
{
  "bannerImageUrl": "https://storage.bunnycdn.com/vormex/banners/user-id.jpg"
}
```

### Get User Feed

**GET** `/api/users/{username}/feed`

Get unified content feed (posts, articles, forum Q&A).

**Parameters:**
- `username` (path) - User's username
- `page` (query, optional) - Page number (default: 1)
- `limit` (query, optional) - Items per page (default: 20, max: 100)
- `filter` (query, optional) - Filter by type: `all`, `posts`, `articles`, `forum`, `videos` (default: `all`)

**Example:**
```bash
curl "http://localhost:3000/api/users/johndoe/feed?page=1&limit=20&filter=articles"
```

**Response:**
```json
{
  "items": [
    {
      "id": "uuid",
      "type": "article",
      "title": "Getting Started with React",
      "content": "...",
      "author": {
        "id": "uuid",
        "name": "John Doe",
        "avatar": "..."
      },
      "createdAt": "2024-01-15T10:30:00Z",
      "likes": 45,
      "comments": 12
    },
    ...
  ],
  "totalCount": 150,
  "hasMore": true
}
```

## Profile Visibility

### PUBLIC
- Anyone can view profile
- No authentication required
- All data visible (except email)

### STUDENTS_ONLY
- Only verified students can view
- Requires authentication
- Email visible to owner only

### CONNECTIONS
- Only connected users can view
- Requires authentication
- Email visible to owner only

## Stats Explained

- **XP**: Experience points from activity
- **Level**: Calculated from XP (levels up every 500 XP)
- **XP to Next Level**: Remaining XP needed
- **Total Posts**: Count of posts created
- **Total Articles**: Count of articles published
- **Current Streak**: Consecutive days with activity
- **Longest Streak**: Best streak ever achieved

## Best Practices

1. **Update Profile Regularly**
   - Keep headline and bio current
   - Add new skills as you learn
   - Update graduation year

2. **Privacy Settings**
   - Use `PUBLIC` for networking
   - Use `STUDENTS_ONLY` for safety
   - Use `CONNECTIONS` for private profiles

3. **Media Uploads**
   - Compress images before upload
   - Use recommended dimensions
   - Optimize for web (WebP format)

4. **Content Feed**
   - Use pagination for large feeds
   - Filter by type for better UX
   - Cache feed data on frontend

## Error Handling

```json
{
  "error": "Profile is private",
  "details": "This user's profile visibility is set to CONNECTIONS"
}
```

Common errors:
- `403`: Private profile (not connected)
- `404`: User not found
- `400`: Validation error (invalid data)
- `401`: Unauthorized (missing/invalid token)

## Examples

### Complete Profile Update

```bash
TOKEN="your-jwt-token"

# Update basic info
curl -X PUT http://localhost:3000/api/users/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "headline": "Full Stack Developer",
    "bio": "Building the future of social networking",
    "location": "Bangalore, India",
    "currentYear": 4,
    "graduationYear": 2025,
    "portfolioUrl": "https://johndoe.dev",
    "linkedinUrl": "https://linkedin.com/in/johndoe",
    "githubProfileUrl": "https://github.com/johndoe",
    "profileVisibility": "PUBLIC"
  }'

# Upload avatar (after uploading to Bunny.net)
curl -X POST http://localhost:3000/api/users/me/avatar \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "avatarUrl": "https://storage.bunnycdn.com/vormex/avatars/user-id.jpg"
  }'

# Upload banner
curl -X POST http://localhost:3000/api/users/me/banner \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bannerUrl": "https://storage.bunnycdn.com/vormex/banners/user-id.jpg"
  }'
```

## Next Steps

- [Activity Calendar Guide](ACTIVITY-CALENDAR.md)
- [Media Upload Guide](MEDIA-UPLOAD.md)

