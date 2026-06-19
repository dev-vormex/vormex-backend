# Vormex Backend API

Professional social networking platform for students - LinkedIn + Instagram reels + GitHub profile + LeetCode stats style.

## 🚀 Quick Start

### Prerequisites

- Node.js 20+ and npm
- PostgreSQL database
- Environment variables configured (see `.env.example`)

### Installation

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# Start development server
# If DATABASE_URL points to Neon, this also starts an automatic DB keep-alive helper
npm run dev
```

By default `npm run dev` skips API Redis realtime fanout and BullMQ
worker/scheduler processes when `REDIS_URL` points at Upstash. This avoids
burning through a low-quota remote Redis while you are only testing the API or
Android client. To intentionally use remote Redis locally, set
`API_REDIS_MODE=true` and `DEV_BACKGROUND_JOBS=true`.

For Android/local API debugging, start only the API server on port `5000` and use the in-memory local rate limiter:

```bash
REDIS_URL= REDIS_REQUIRED=false PORT=5000 npm run dev:server
```

If you see `ERR Your database has been temporarily rate-limited` from worker
logs, treat it as a Redis capacity issue. Use a local Redis for development,
keep `WORKER_CONCURRENCY` low on starter Redis plans, or upgrade the Redis plan
for production background jobs.

When remote Upstash Redis is skipped in development, bearer JWTs are allowed to
survive backend restarts. Production should keep `AUTH_REQUIRE_SESSION_ID=true`
so access tokens remain bound to server-side sessions.

If you want to disable the automatic Neon keep-alive helper for a session, run with `AUTO_KEEP_DB_AWAKE=false`.

### Render Deploy

This repo includes `render.yaml` with the production settings for Render.

If you configure the service manually in the Render dashboard, use:

```bash
Build Command: npm ci && npm run build
Pre-Deploy Command: npm run migrate:deploy
Start Command: npm start
Health Check Path: /api/health
```

### Database Pooling

Production API, worker, and scheduler processes should connect to Postgres
through a transaction-mode pooler, not the direct database host. Use the managed
pooler from your provider when available: Supabase/Neon pooled connection,
PgBouncer, RDS Proxy, or an equivalent transaction pooler.

Required production shape:

```bash
# Runtime app traffic: pooled transaction-mode endpoint.
DATABASE_URL="postgresql://user:pass@pooler-host:6543/db?sslmode=require&pgbouncer=true&connection_limit=3"

# Optional read split: use the read-replica pooler if your provider exposes one.
READ_DATABASE_URL="postgresql://user:pass@read-pooler-host:6543/db?sslmode=require&pgbouncer=true&connection_limit=3"

# Migrations only: direct Postgres endpoint, not PgBouncer.
DIRECT_URL="postgresql://user:pass@direct-db-host:5432/db?sslmode=require"
```

Recommended starting point per API/worker instance:

- `PRISMA_CONNECTION_LIMIT=3`
- `PRISMA_READ_CONNECTION_LIMIT=3`
- `PRISMA_PGBOUNCER=auto` or `true`
- Pooler `default_pool_size`: start near `10-20`, then tune to DB size.
- Pooler `max_client_conn`: high enough for app instances, workers, deploys, and admin access.

Keep `DB_POOLER_REQUIRED=true` in production so the app fails fast if runtime
traffic is accidentally pointed at a direct Postgres URL. Prisma migrations use
`DIRECT_URL` from `schema.prisma`; run them with the normal deploy command
before starting new app instances.

This package also includes a `postinstall` hook that runs `npm run build`. That makes Render's default Node build behavior safer, because a plain `npm install` will still generate `dist/api.js`.

The startup path also goes through `node scripts/run-compiled.js api`, which rebuilds the compiled entry if `dist/api.js` is missing. That gives Render a safe fallback if the service ever skips the build phase or reuses a bad cache.

### API Documentation

Once the server is running, visit:

- **Swagger UI**: http://localhost:3000/api-docs
- **ReDoc**: http://localhost:3000/api-docs/redoc
- **OpenAPI JSON**: http://localhost:3000/api-docs/swagger.json
- **OpenAPI YAML**: http://localhost:3000/api-docs/openapi.yaml

### Keep Alive

To reduce cold starts on sleeping hosts, the repo includes a GitHub Actions workflow at `.github/workflows/keep-alive.yml`.

- It pings the production health endpoint every 5 minutes
- Default URL: `https://api.vormex.in/api/health`
- Optional override: set a GitHub Actions repository variable named `BACKEND_KEEPALIVE_URL`

Important: this only works if GitHub Actions is enabled for the repository. A self-ping inside the backend process will not wake a host that has already gone to sleep.

## 📚 API Overview

### Base URL

- **Development**: `http://localhost:3000/api`
- **Production**: `https://api.vormex.in/api`

### Authentication

Most endpoints require JWT authentication. Include the token in the Authorization header:

```bash
Authorization: Bearer <your-jwt-token>
```

## 🔐 Authentication Flow

### 1. Register

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "student@example.com",
    "password": "SecurePass123!",
    "name": "John Doe",
    "college": "VIT Vellore",
    "branch": "Computer Science"
  }'
```

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "student@example.com",
    "name": "John Doe",
    ...
  },
  "token": "jwt-token-here"
}
```

### 2. Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "student@example.com",
    "password": "SecurePass123!"
  }'
```

### 3. Get Current User

```bash
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <token>"
```

### 4. Google OAuth

```bash
curl -X POST http://localhost:3000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{
    "idToken": "google-id-token-from-client"
  }'
```

## 👤 Profile API

### Get User Profile

```bash
curl -X GET http://localhost:3000/api/users/{username}/profile \
  -H "Authorization: Bearer <token>"
```

**Response includes:**
- User information
- Stats (XP, level, streaks)
- GitHub integration status
- Activity heatmap (last 365 days)
- Skills, Experience, Education, Projects, Certificates, Achievements

### Update Profile

```bash
curl -X PUT http://localhost:3000/api/users/me \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "headline": "Software Engineering Student",
    "bio": "Passionate about building great products",
    "location": "Vellore, India",
    "currentYear": 3,
    "degree": "B.Tech",
    "graduationYear": 2025
  }'
```

### Upload Avatar/Banner

```bash
# Upload avatar
curl -X POST http://localhost:3000/api/users/me/avatar \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "avatarUrl": "https://storage.bunnycdn.com/vormex/avatars/user-id.jpg"
  }'

# Upload banner
curl -X POST http://localhost:3000/api/users/me/banner \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "bannerUrl": "https://storage.bunnycdn.com/vormex/banners/user-id.jpg"
  }'
```

## 📊 Activity Calendar (GitHub-Style)

### Get Activity Heatmap

```bash
# Default view (last 365 days)
curl -X GET http://localhost:3000/api/users/{userId}/activity

# Specific year
curl -X GET "http://localhost:3000/api/users/{userId}/activity?year=2024"
```

**Response:**
```json
{
  "days": [
    {
      "date": "2024-01-01",
      "activityCount": 5,
      "isActive": true,
      "level": 2,
      "breakdown": {
        "posts": 2,
        "comments": 3,
        ...
      }
    },
    ...
  ],
  "stats": {
    "totalContributions": 487,
    "currentStreak": 12,
    "longestStreak": 45,
    "contributionLevels": {
      "level0": 150,
      "level1": 100,
      "level2": 80,
      "level3": 35
    }
  }
}
```

### Get Available Years

```bash
curl -X GET http://localhost:3000/api/users/{userId}/activity/years
```

**Response:**
```json
{
  "years": [2023, 2024, 2025],
  "joinedYear": 2023
}
```

## 🔗 GitHub Integration

### Start GitHub OAuth

```bash
curl -X GET http://localhost:3000/api/integrations/github/start \
  -H "Authorization: Bearer <token>"
```

**Response:**
```json
{
  "authUrl": "https://github.com/login/oauth/authorize?..."
}
```

Redirect user to `authUrl`, then handle callback at `/integrations/github/callback`.

### Sync GitHub Stats

```bash
curl -X POST http://localhost:3000/api/integrations/github/sync \
  -H "Authorization: Bearer <token>"
```

### Get GitHub Stats

```bash
curl -X GET http://localhost:3000/api/integrations/github/stats \
  -H "Authorization: Bearer <token>"
```

### Disconnect GitHub

```bash
curl -X POST http://localhost:3000/api/integrations/github/disconnect \
  -H "Authorization: Bearer <token>"
```

## 💼 Professional Fields

### Skills

```bash
# Add skill
curl -X POST http://localhost:3000/api/users/me/skills \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "skillName": "React",
    "proficiency": "Advanced",
    "yearsOfExp": 2
  }'

# Update skill
curl -X PUT http://localhost:3000/api/users/me/skills/{id} \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "proficiency": "Expert",
    "yearsOfExp": 3
  }'

# Delete skill
curl -X DELETE http://localhost:3000/api/users/me/skills/{id} \
  -H "Authorization: Bearer <token>"

# Search skills (public)
curl -X GET "http://localhost:3000/api/skills/search?q=react"
```

### Experience

```bash
# Create experience
curl -X POST http://localhost:3000/api/users/me/experiences \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Software Engineering Intern",
    "company": "Google",
    "type": "Internship",
    "location": "Mountain View, CA",
    "startDate": "2024-06-01",
    "endDate": "2024-08-31",
    "isCurrent": false,
    "description": "Worked on Google Cloud Platform",
    "skills": ["Python", "Go", "Kubernetes"]
  }'

# Get user experiences (public)
curl -X GET http://localhost:3000/api/users/{userId}/experiences
```

### Education

```bash
# Create education
curl -X POST http://localhost:3000/api/users/me/education \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "school": "VIT Vellore",
    "degree": "B.Tech",
    "fieldOfStudy": "Computer Science",
    "startDate": "2021-08-01",
    "endDate": "2025-05-31",
    "isCurrent": true,
    "grade": "8.5/10"
  }'
```

### Projects

```bash
# Create project
curl -X POST http://localhost:3000/api/users/me/projects \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E-Commerce Platform",
    "description": "Full-stack e-commerce application",
    "role": "Full Stack Developer",
    "techStack": ["React", "Node.js", "PostgreSQL"],
    "startDate": "2024-01-01",
    "endDate": "2024-03-31",
    "isCurrent": false,
    "projectUrl": "https://example.com",
    "githubUrl": "https://github.com/user/repo",
    "images": ["https://storage.bunnycdn.com/..."],
    "featured": true
  }'

# Feature project (max 3)
curl -X POST http://localhost:3000/api/users/me/projects/{id}/feature \
  -H "Authorization: Bearer <token>"
```

### Certificates

```bash
# Create certificate
curl -X POST http://localhost:3000/api/users/me/certificates \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AWS Certified Solutions Architect",
    "issuingOrg": "Amazon Web Services",
    "issueDate": "2024-01-15",
    "expiryDate": "2027-01-15",
    "doesNotExpire": false,
    "credentialId": "AWS-123456",
    "credentialUrl": "https://aws.amazon.com/verification"
  }'
```

### Achievements

```bash
# Create achievement
curl -X POST http://localhost:3000/api/users/me/achievements \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Winner - Hackathon 2024",
    "type": "Hackathon",
    "organization": "TechFest",
    "date": "2024-03-15",
    "description": "Won first place in AI/ML category",
    "certificateUrl": "https://storage.bunnycdn.com/..."
  }'
```

## ❌ Error Codes

| Status Code | Description |
|------------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Validation error |
| 401 | Unauthorized - Invalid or missing token |
| 403 | Forbidden - Access denied |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Resource already exists |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Database connection failed |

### Error Response Format

```json
{
  "error": "Human-readable error message",
  "details": "Additional error details (optional)",
  "code": "ERROR_CODE (optional)"
}
```

## 🚦 Rate Limits

Rate limiting is planned for future implementation with Redis. Current limits:

- **Authentication endpoints**: 5 requests/minute per IP
- **GitHub sync**: 1 request/hour per user
- **General API**: 100 requests/minute per user

## 📦 Media Storage (Bunny.net)

Vormex uses Bunny.net for media storage. See [docs/MEDIA-UPLOAD.md](docs/MEDIA-UPLOAD.md) for details.

### Upload Flow

1. Frontend uploads file to Bunny.net CDN
2. Frontend receives CDN URL
3. Frontend sends CDN URL to backend API
4. Backend stores URL in database

## 🏗️ Project Structure

```
src/
├── config/          # Configuration (Prisma, etc.)
├── controllers/     # Route handlers
├── middleware/      # Auth, error handling
├── routes/          # Route definitions
├── services/        # Business logic
├── types/           # TypeScript types
├── utils/           # Helper functions
├── openapi.yaml     # OpenAPI specification
├── swagger.ts       # Swagger UI setup
└── index.ts         # Server entry point
```

## 🧪 Testing

```bash
# Run health check
curl http://localhost:3000/api/health

# Expected response:
{
  "status": "ok",
  "timestamp": 1234567890,
  "database": "connected"
}
```

## 📝 Documentation Scripts

```bash
# Generate OpenAPI JSON from YAML
npm run docs:generate

# Validate OpenAPI spec
npm run docs:validate

# Generate and start server
npm run docs:serve
```

## 🔄 CI/CD

GitHub Actions workflow validates OpenAPI spec on every push. See `.github/workflows/docs.yml`.

## 📖 Additional Documentation

- [Getting Started Guide](docs/GETTING-STARTED.md)
- [Profile API Details](docs/PROFILE-API.md)
- [Activity Calendar Guide](docs/ACTIVITY-CALENDAR.md)
- [Media Upload Guide](docs/MEDIA-UPLOAD.md)
- [Redis Caching (Planned)](docs/REDIS-CACHING.md)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Update OpenAPI spec if adding/modifying endpoints
5. Run `npm run docs:validate` to check spec
6. Submit a pull request

## 📄 License

ISC

## 🆘 Support

For issues and questions:
- Email: support@vormex.in
- API Docs: http://localhost:3000/api-docs
