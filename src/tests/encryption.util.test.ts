import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const {
  decryptToken,
  encryptToken,
} = require('../utils/encryption.util') as typeof import('../utils/encryption.util');

test('stored secrets use authenticated encryption and reject tampering', () => {
  const encrypted = encryptToken('github-access-token');

  assert.match(encrypted, /^v2:[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/);
  assert.equal(decryptToken(encrypted), 'github-access-token');

  const replacement = encrypted.endsWith('0') ? '1' : '0';
  const tampered = `${encrypted.slice(0, -1)}${replacement}`;
  assert.throws(() => decryptToken(tampered));
});

test('legacy AES-CBC stored secrets remain decryptable during migration', () => {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex');
  const iv = Buffer.alloc(16, 7);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update('legacy-token', 'utf8', 'hex');
  encrypted += cipher.final('hex');

  assert.equal(decryptToken(`${iv.toString('hex')}:${encrypted}`), 'legacy-token');
});
