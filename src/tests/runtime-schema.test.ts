import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { missingRuntimeColumns, assertRuntimeSchema } from '../config/runtime-schema';

const columns = Prisma.dmmf.datamodel.models.flatMap((model) =>
  model.fields.filter((field) => field.kind !== 'object').map((field) => ({
    table_name: model.dbName || model.name,
    column_name: field.dbName || field.name,
  }))
);

test('runtime schema accepts all generated columns and ignores relations', () => {
  assert.deepEqual(missingRuntimeColumns(columns), []);
});

test('schema check uses the Prisma URL schema instead of the role search path', async () => {
  for (const [url, expected] of [
    ['postgresql://localhost/db', 'public'],
    ['postgresql://localhost/db?schema=app', 'app'],
  ]) {
    await assertRuntimeSchema({
      $queryRaw: async <T>(_query: TemplateStringsArray, ...values: unknown[]) => {
        assert.deepEqual(values, [expected]);
        return columns as T;
      },
    }, url);
  }
});

test('runtime schema reports the mapped columns from the failing chat, presence and feed queries', async () => {
  const absent = new Set(['users.adminTwoFactorPendingSecret', 'messages.hiddenForUserIds', 'conversations.hiddenForUserIds', 'feed_impressions.creatorId', 'feed_impressions.seenCount']);
  const old = columns.filter((c) => !absent.has(`${c.table_name}.${c.column_name}`));
  assert.deepEqual(new Set(missingRuntimeColumns(old)), absent);
  await assert.rejects(assertRuntimeSchema({ $queryRaw: async <T>() => old as T }), /migrate:deploy/);
});

test('development bootstrap includes current feature migrations using the physical users table', () => {
  const bootstrap = readFileSync('scripts/ensure-dev-schema.js', 'utf8');
  for (const name of ['20260814120000_add_personalized_home_feed', 'scripts/sql/ensure-runtime-columns.sql']) {
    assert.ok(bootstrap.includes(name));
  }
  const security = readFileSync('prisma/migrations/20260825120000_security_boundary_hardening/migration.sql', 'utf8');
  assert.doesNotMatch(security, /(?:ALTER TABLE|UPDATE) "User"/);
  assert.match(security, /ALTER TABLE "users"/);
  const runtime = readFileSync('scripts/sql/ensure-runtime-columns.sql', 'utf8');
  assert.doesNotMatch(runtime, /UPDATE |DELETE |DROP /);
});
