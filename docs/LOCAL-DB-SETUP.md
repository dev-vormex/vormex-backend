# Local Database Setup (Single Fix for Neon Suspension Errors)

## Why This Fix?

Neon **suspends** development databases after ~5 min of inactivity. When suspended:
- You get `P1001: Can't reach database server`
- Connection string can change after restore
- You waste time debugging "random" 500 errors

**Solution:** Use **local PostgreSQL** for development. Neon only for production.

---

## One-Time Setup (5 minutes)

### 1. Install PostgreSQL

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install postgresql postgresql-contrib -y
sudo systemctl start postgresql
```

**macOS (Homebrew):**
```bash
brew install postgresql@16
brew services start postgresql@16
```

### 2. Create Local Database

```bash
sudo -u postgres psql -c "CREATE USER vormex WITH PASSWORD 'vormex123';"
sudo -u postgres psql -c "CREATE DATABASE vormex OWNER vormex;"
```

### 3. Update .env for Development

In `vormex-backend/.env`, set:

```
DATABASE_URL="postgresql://vormex:vormex123@localhost:5432/vormex"
DIRECT_URL="postgresql://vormex:vormex123@localhost:5432/vormex"
```

### 4. Run Migrations

```bash
cd vormex-backend
npx prisma migrate deploy
# or if you need to reset: npx prisma migrate reset
npx prisma generate
npm run dev
```

---

## For Production

Keep your Neon URLs in a **separate** `.env.production` or use environment variables in your deployment (Vercel, Railway, etc.). Never commit production URLs.

---

## Summary

| Environment | Database        | No more suspension errors |
|-------------|-----------------|---------------------------|
| Development | Local PostgreSQL| ✅                        |
| Production  | Neon            | ✅ (always-on on paid)    |
