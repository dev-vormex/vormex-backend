import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertDatabasePoolConfig,
  buildDatabasePoolConfig,
  isLikelyPooledPostgresUrl,
  withPrismaPoolParams,
} from '../config/database-url.util';

test('pooled database URLs get small Prisma pool limits and PgBouncer compatibility', () => {
  const pooled = withPrismaPoolParams(
    'postgresql://user:pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require',
    { connectionLimit: '3', pgbouncer: 'auto' }
  );

  assert.ok(pooled);
  const url = new URL(pooled);
  assert.equal(url.searchParams.get('connection_limit'), '3');
  assert.equal(url.searchParams.get('pgbouncer'), 'true');
  assert.equal(isLikelyPooledPostgresUrl(pooled), true);
});

test('direct database URLs keep migrations separate and fail when pooler is required', () => {
  const env = {
    NODE_ENV: 'production',
    DB_POOLER_REQUIRED: 'true',
    DATABASE_URL: 'postgresql://user:pass@direct-db.example.com:5432/vormex?sslmode=require',
    DIRECT_URL: 'postgresql://user:pass@direct-db.example.com:5432/vormex?sslmode=require',
    PRISMA_CONNECTION_LIMIT: '2',
  };
  const config = buildDatabasePoolConfig({ env, role: 'write' });

  assert.equal(config.isLikelyPooled, false);
  assert.match(config.url || '', /connection_limit=2/);
  assert.throws(() => assertDatabasePoolConfig([config], env), /transaction-pooler URL/);
});

test('read replica URL keeps write/read split and uses read connection limit', () => {
  const config = buildDatabasePoolConfig({
    role: 'read',
    env: {
      READ_DATABASE_URL: 'postgresql://user:pass@read-pooler.example.com:6543/vormex?sslmode=require',
      PRISMA_READ_CONNECTION_LIMIT: '4',
      PRISMA_PGBOUNCER: 'true',
    },
  });

  assert.ok(config.url);
  const url = new URL(config.url);
  assert.equal(url.searchParams.get('connection_limit'), '4');
  assert.equal(url.searchParams.get('pgbouncer'), 'true');
});

test('Prisma config uses pooled runtime URLs, DIRECT_URL remains schema-only, and metrics collect DB connections', () => {
  const prismaConfig = readFileSync(join(process.cwd(), 'src/config/prisma.ts'), 'utf8');
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const index = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  const registry = readFileSync(join(process.cwd(), 'src/infrastructure/metrics/registry.ts'), 'utf8');

  assert.match(prismaConfig, /buildDatabasePoolConfig\(\{ env: process\.env, role: 'write' \}\)/);
  assert.match(prismaConfig, /buildDatabasePoolConfig\(\{ env: process\.env, role: 'read' \}\)/);
  assert.match(prismaConfig, /buildClient\(logQueries, writePoolConfig\.url\)/);
  assert.match(schema, /directUrl = env\("DIRECT_URL"\)/);
  assert.match(index, /collectDbConnectionMetrics/);
  assert.match(registry, /vormex_db_connections/);
});
