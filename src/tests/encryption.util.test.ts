import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const currentKeyHex = crypto.randomBytes(32).toString('hex');
const previousKeyHex = crypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = currentKeyHex;
process.env.ENCRYPTION_KEY_PREVIOUS = previousKeyHex;

const {
  decryptToken,
  decryptTokenWithMetadata,
  encryptToken,
} = require('../utils/encryption.util') as typeof import('../utils/encryption.util');
const {
  inspectAdminTwoFactorSecret,
  reencryptAdminTwoFactorSecret,
  reencryptStoredSecret,
} = require('../services/encryption-rotation.service') as typeof import('../services/encryption-rotation.service');
const {
  listIdentityEvidenceStorageKeys,
  readEncryptedIdentityEvidenceWithMetadata,
  rotateEncryptedIdentityEvidence,
} = require('../services/identity-evidence.service') as typeof import('../services/identity-evidence.service');

function encryptV2WithKey(plaintext: string, keyHex: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v2',
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

function encryptLegacyWithKey(plaintext: string, keyHex: string): string {
  const iv = Buffer.alloc(16, 7);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}`;
}

function encryptEvidenceWithKey(plaintext: Buffer, keyHex: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('VXID1'), iv, cipher.getAuthTag(), ciphertext]);
}

test('new stored secrets use the current authenticated key and reject tampering', () => {
  const encrypted = encryptToken('github-access-token');

  assert.match(encrypted, /^v2:[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/);
  assert.deepEqual(decryptTokenWithMetadata(encrypted), {
    plaintext: 'github-access-token',
    keySource: 'current',
    format: 'v2',
  });

  const replacement = encrypted.endsWith('0') ? '1' : '0';
  const tampered = `${encrypted.slice(0, -1)}${replacement}`;
  assert.throws(() => decryptToken(tampered));
});

test('authenticated values fall back to the previous key without changing new writes', () => {
  const encrypted = encryptV2WithKey('previous-key-token', previousKeyHex);

  assert.deepEqual(decryptTokenWithMetadata(encrypted), {
    plaintext: 'previous-key-token',
    keySource: 'previous',
    format: 'v2',
  });
  assert.equal(decryptToken(encrypted), 'previous-key-token');
  assert.equal(decryptTokenWithMetadata(encryptToken('new-write')).keySource, 'current');
});

test('legacy AES-CBC values prefer the previous key during dual-key migration', () => {
  const encrypted = encryptLegacyWithKey('legacy-token', previousKeyHex);

  assert.deepEqual(decryptTokenWithMetadata(encrypted), {
    plaintext: 'legacy-token',
    keySource: 'previous',
    format: 'legacy',
  });
});

test('stored secret re-encryption is verified and idempotent', () => {
  const oldValue = encryptV2WithKey('rotate-me', previousKeyHex);
  const first = reencryptStoredSecret(oldValue);

  assert.equal(first.keySource, 'previous');
  assert.equal(first.needsRotation, true);
  assert.ok(first.replacement);
  assert.deepEqual(decryptTokenWithMetadata(first.replacement!), {
    plaintext: 'rotate-me',
    keySource: 'current',
    format: 'v2',
  });

  const second = reencryptStoredSecret(first.replacement!);
  assert.equal(second.needsRotation, false);
  assert.equal(second.replacement, null);
});

test('plaintext admin 2FA secrets are wrapped and encrypted during migration', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  assert.deepEqual(inspectAdminTwoFactorSecret(secret), {
    format: 'plaintext',
    keySource: 'none',
    needsRotation: true,
  });

  const rotated = reencryptAdminTwoFactorSecret(secret);
  assert.ok(rotated.replacement?.startsWith('enc:v2:'));
  assert.equal(decryptToken(rotated.replacement!.slice(4)), secret);
});

test('identity evidence rotation backs up old ciphertext and is idempotent', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vormex-key-rotation-'));
  const evidenceDirectory = path.join(temporaryRoot, 'evidence');
  const backupDirectory = path.join(temporaryRoot, 'backup');
  const storageKey = '2026-07-29/test-user/evidence.bin';
  const evidencePath = path.join(evidenceDirectory, ...storageKey.split('/'));
  const plaintext = Buffer.from('identity-evidence-fixture');
  const oldPayload = encryptEvidenceWithKey(plaintext, previousKeyHex);
  process.env.IDENTITY_EVIDENCE_DIR = evidenceDirectory;

  try {
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, oldPayload);

    assert.deepEqual(await listIdentityEvidenceStorageKeys(), [storageKey]);
    const initial = await readEncryptedIdentityEvidenceWithMetadata(storageKey);
    assert.equal(initial.keySource, 'previous');
    assert.equal(initial.buffer.equals(plaintext), true);

    const dryRun = await rotateEncryptedIdentityEvidence({ dryRun: true, storageKey });
    assert.deepEqual(dryRun, { keySource: 'previous', rotated: false });
    assert.equal((await fs.readFile(evidencePath)).equals(oldPayload), true);

    const applied = await rotateEncryptedIdentityEvidence({
      backupDirectory,
      dryRun: false,
      storageKey,
    });
    assert.deepEqual(applied, { keySource: 'previous', rotated: true });
    assert.equal(
      (await fs.readFile(path.join(backupDirectory, ...storageKey.split('/')))).equals(oldPayload),
      true
    );

    const persisted = await readEncryptedIdentityEvidenceWithMetadata(storageKey);
    assert.equal(persisted.keySource, 'current');
    assert.equal(persisted.buffer.equals(plaintext), true);

    const repeated = await rotateEncryptedIdentityEvidence({
      backupDirectory,
      dryRun: false,
      storageKey,
    });
    assert.deepEqual(repeated, { keySource: 'current', rotated: false });
  } finally {
    delete process.env.IDENTITY_EVIDENCE_DIR;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
