import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PushNotificationService,
  resolvePushNotificationMode,
} from '../services/push-notification.service';

const ENV_KEYS = [
  'NODE_ENV',
  'PUSH_NOTIFICATIONS_ENABLED',
  'FIREBASE_PUSH_MOCK_MODE',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
] as const;

function withEnv<T>(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => T): T {
  const original = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    original.set(key, process.env[key]);
  }

  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('missing Firebase config fails startup in production unless push is explicitly disabled', () => {
  withEnv({
    NODE_ENV: 'production',
    PUSH_NOTIFICATIONS_ENABLED: undefined,
    FIREBASE_PUSH_MOCK_MODE: undefined,
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_CLIENT_EMAIL: undefined,
    FIREBASE_PRIVATE_KEY: undefined,
  }, () => {
    assert.throws(
      () => resolvePushNotificationMode(),
      /Firebase Admin credentials are missing/
    );
  });

  withEnv({
    NODE_ENV: 'production',
    PUSH_NOTIFICATIONS_ENABLED: 'false',
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_CLIENT_EMAIL: undefined,
    FIREBASE_PRIVATE_KEY: undefined,
  }, () => {
    assert.equal(resolvePushNotificationMode(), 'disabled');
  });
});

test('Firebase mock mode is explicit and never allowed in production', () => {
  withEnv({
    NODE_ENV: 'test',
    FIREBASE_PUSH_MOCK_MODE: 'true',
    PUSH_NOTIFICATIONS_ENABLED: undefined,
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_CLIENT_EMAIL: undefined,
    FIREBASE_PRIVATE_KEY: undefined,
  }, () => {
    assert.equal(resolvePushNotificationMode(), 'mock');
  });

  withEnv({
    NODE_ENV: 'production',
    FIREBASE_PUSH_MOCK_MODE: 'true',
    PUSH_NOTIFICATIONS_ENABLED: undefined,
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_CLIENT_EMAIL: undefined,
    FIREBASE_PRIVATE_KEY: undefined,
  }, () => {
    assert.throws(
      () => resolvePushNotificationMode(),
      /Firebase Admin credentials are missing/
    );
  });
});

test('disabled push does not silently fake success per call', async () => {
  const sent = await withEnv({
    NODE_ENV: 'test',
    PUSH_NOTIFICATIONS_ENABLED: 'false',
    FIREBASE_PUSH_MOCK_MODE: undefined,
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_CLIENT_EMAIL: undefined,
    FIREBASE_PRIVATE_KEY: undefined,
  }, async () => {
    const service = new PushNotificationService();
    return service.sendToUser('user-1', {
      title: 'Hello',
      body: 'World',
    });
  });

  assert.equal(sent, false);
});
