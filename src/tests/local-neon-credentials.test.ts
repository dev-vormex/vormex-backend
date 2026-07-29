import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

const {
  loadProtectedLocalDatabaseCredentials,
  withCredential,
} = require(join(process.cwd(), 'scripts', 'local-neon-credentials.js')) as {
  loadProtectedLocalDatabaseCredentials: (options: Record<string, unknown>) => {
    status: string;
    reason?: string;
  };
  withCredential: (
    rawUrl: string,
    role: string,
    password: string,
    requirePooler: boolean
  ) => string;
};

test('protected local credentials replace stale URL authentication without changing hosts', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'development',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    DATABASE_URL:
      'postgresql://stale:stale@ep-example-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    DIRECT_URL:
      'postgresql://stale:stale@ep-example.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  };

  const result = loadProtectedLocalDatabaseCredentials({
    env,
    platform: 'win32',
    secretsDir: 'C:\\protected',
    exists: () => true,
    readRecord: (_filePath: string, role: string) => ({
      role,
      ciphertext: role,
    }),
    unprotect: (ciphertext: string) => `${ciphertext}-password`,
  });

  assert.equal(result.status, 'loaded');
  const pooled = new URL(String(env.DATABASE_URL));
  const direct = new URL(String(env.DIRECT_URL));
  assert.equal(pooled.username, 'vormex_runtime');
  assert.equal(pooled.password, 'vormex_runtime-password');
  assert.equal(pooled.hostname, 'ep-example-pooler.ap-southeast-1.aws.neon.tech');
  assert.equal(direct.username, 'neondb_owner');
  assert.equal(direct.password, 'neondb_owner-password');
  assert.equal(direct.hostname, 'ep-example.ap-southeast-1.aws.neon.tech');
});

test('protected local credential loading never runs in production', () => {
  const result = loadProtectedLocalDatabaseCredentials({
    env: { NODE_ENV: 'production' },
    platform: 'win32',
    exists: () => {
      throw new Error('must not inspect local credential files');
    },
  });

  assert.deepEqual(result, { status: 'skipped', reason: 'production' });
});

test('database URL roles reject using a direct and pooled endpoint interchangeably', () => {
  assert.throws(
    () =>
      withCredential(
        'postgresql://user:password@ep-example.ap-southeast-1.aws.neon.tech/neondb',
        'vormex_runtime',
        'password',
        true
      ),
    /pooled Neon endpoint/
  );
});
