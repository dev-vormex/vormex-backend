# Getting Started with Vormex API

This guide will help you get started with the Vormex API quickly.

## Prerequisites

- Node.js 18+ and npm
- PostgreSQL database (local or remote)
- Git
- Basic knowledge of REST APIs

## Setup

### 1. Clone Repository

```bash
git clone <repository-url>
cd vormex-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env` and fill in the required variables:

```bash
cp .env.example .env
```

Required environment variables:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/vormex"

# JWT
JWT_SECRET="your-secret-key-here"
JWT_EXPIRES_IN="7d"

# GitHub OAuth
GITHUB_CLIENT_ID="your-github-client-id"
GITHUB_CLIENT_SECRET="your-github-client-secret"
GITHUB_CALLBACK_URL="http://localhost:3000/api/integrations/github/callback"

# Frontend
FRONTEND_URL="http://localhost:3001"

# Encryption (64 hex characters)
ENCRYPTION_KEY="your-64-character-hex-key"

# Email (Resend)
RESEND_API_KEY="your-resend-api-key"

# Bunny.net (Media Storage)
BUNNY_STORAGE_ZONE="your-storage-zone"
BUNNY_ACCESS_KEY="your-access-key"
BUNNY_CDN_URL="https://your-cdn.b-cdn.net"
```

### 4. Database Setup

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# (Optional) Open Prisma Studio to view data
npm run prisma:studio
```

### 5. Start Server

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build
npm start
```

Server will start at `http://localhost:3000`

## First API Call

### Health Check

```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "database": "connected"
}
```

### Register a User

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test1234!",
    "name": "Test User",
    "college": "Test University",
    "branch": "Computer Science"
  }'
```

Save the `token` from the response for authenticated requests.

### Get Your Profile

```bash
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <your-token>"
```

## API Documentation

Once the server is running:

1. **Swagger UI**: http://localhost:3000/api-docs
   - Interactive API explorer
   - Try out endpoints directly
   - See request/response examples

2. **ReDoc**: http://localhost:3000/api-docs/redoc
   - Beautiful, responsive documentation
   - Better for reading

3. **OpenAPI Spec**: 
   - JSON: http://localhost:3000/api-docs/swagger.json
   - YAML: http://localhost:3000/api-docs/openapi.yaml

## Common Workflows

### 1. User Registration & Profile Setup

```bash
# 1. Register
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"Pass123!","name":"John Doe"}' \
  | jq -r '.token')

# 2. Update profile
curl -X PUT http://localhost:3000/api/users/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "headline": "Software Engineering Student",
    "bio": "Passionate developer",
    "currentYear": 3
  }'

# 3. Add skill
curl -X POST http://localhost:3000/api/users/me/skills \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "skillName": "React",
    "proficiency": "Advanced",
    "yearsOfExp": 2
  }'
```

### 2. GitHub Integration

```bash
# 1. Start OAuth flow
curl -X GET http://localhost:3000/api/integrations/github/start \
  -H "Authorization: Bearer $TOKEN"

# 2. User authorizes on GitHub, callback handled automatically

# 3. Sync stats
curl -X POST http://localhost:3000/api/integrations/github/sync \
  -H "Authorization: Bearer $TOKEN"

# 4. View stats
curl -X GET http://localhost:3000/api/integrations/github/stats \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Activity Calendar

```bash
# Get activity heatmap (last 365 days)
curl -X GET http://localhost:3000/api/users/{userId}/activity \
  -H "Authorization: Bearer $TOKEN"

# Get specific year
curl -X GET "http://localhost:3000/api/users/{userId}/activity?year=2024" \
  -H "Authorization: Bearer $TOKEN"

# Get available years
curl -X GET http://localhost:3000/api/users/{userId}/activity/years \
  -H "Authorization: Bearer $TOKEN"
```

## Testing with Postman

1. Import OpenAPI spec:
   - Go to Postman → Import
   - Select "Link" tab
   - Enter: `http://localhost:3000/api-docs/swagger.json`

2. Set up environment:
   - Create new environment
   - Add variable: `base_url` = `http://localhost:3000/api`
   - Add variable: `token` = (your JWT token)

3. Use `{{base_url}}` and `{{token}}` in requests

## Next Steps

- Read [Profile API Guide](PROFILE-API.md) for detailed profile operations
- Check [Activity Calendar Guide](ACTIVITY-CALENDAR.md) for GitHub-style contribution tracking
- See [Media Upload Guide](MEDIA-UPLOAD.md) for Bunny.net integration

## Troubleshooting

### Database Connection Error

```bash
# Check PostgreSQL is running
pg_isready

# Verify DATABASE_URL in .env
echo $DATABASE_URL
```

### Port Already in Use

```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>
```

### JWT Token Expired

Tokens expire after 7 days. Re-login to get a new token:

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"Pass123!"}'
```

## Support

- API Documentation: http://localhost:3000/api-docs
- Email: support@vormex.in

