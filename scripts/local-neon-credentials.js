#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME_ROLE = 'vormex_runtime';
const OWNER_ROLE = 'neondb_owner';
const RUNTIME_RECORD = 'vormex_runtime.dpapi.json';
const OWNER_RECORD = 'production_neondb_owner.dpapi.json';

function defaultSecretsDir(env) {
  if (!env.LOCALAPPDATA) return '';
  return path.join(env.LOCALAPPDATA, 'Vormex', 'secrets');
}

function readCredentialRecord(filePath, expectedRole) {
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const protection = String(record?.protection || '').toLowerCase();
  if (
    !protection.includes('dpapi') ||
    !protection.includes('currentuser') ||
    record?.role !== expectedRole ||
    typeof record?.ciphertext !== 'string' ||
    record.ciphertext.length === 0
  ) {
    throw new Error(`Protected credential metadata is invalid for ${expectedRole}.`);
  }
  return record;
}

function unprotectCredential(ciphertext) {
  const command =
    '$e=[Console]::In.ReadToEnd();' +
    '$s=ConvertTo-SecureString -String $e;' +
    '$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);' +
    'try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}' +
    'finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      input: ciphertext,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024,
    }
  );

  if (result.status !== 0 || !result.stdout) {
    throw new Error('Windows-protected database credential recovery failed.');
  }
  return result.stdout;
}

function withCredential(rawUrl, role, password, requirePooler) {
  const url = new URL(rawUrl);
  const isPooler = url.hostname.includes('-pooler.');
  if (isPooler !== requirePooler) {
    throw new Error(
      requirePooler
        ? 'DATABASE_URL must use the pooled Neon endpoint.'
        : 'DIRECT_URL must use the direct Neon endpoint.'
    );
  }
  url.username = role;
  url.password = password;
  return url.toString();
}

function loadProtectedLocalDatabaseCredentials(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  if (env.NODE_ENV === 'production') {
    return { status: 'skipped', reason: 'production' };
  }
  if (env.VORMEX_USE_PROTECTED_DB_CREDENTIALS === 'false') {
    return { status: 'skipped', reason: 'disabled' };
  }
  if (platform !== 'win32') {
    return { status: 'skipped', reason: 'unsupported-platform' };
  }

  const secretsDir =
    options.secretsDir ||
    env.VORMEX_LOCAL_SECRETS_DIR ||
    defaultSecretsDir(env);
  if (!secretsDir) {
    return { status: 'skipped', reason: 'secrets-directory-unavailable' };
  }

  const runtimePath = path.join(secretsDir, RUNTIME_RECORD);
  const ownerPath = path.join(secretsDir, OWNER_RECORD);
  const exists = options.exists || fs.existsSync;
  if (!exists(runtimePath) || !exists(ownerPath)) {
    return { status: 'skipped', reason: 'protected-records-missing' };
  }
  if (!env.DATABASE_URL || !env.DIRECT_URL) {
    throw new Error('DATABASE_URL and DIRECT_URL templates are required in .env.');
  }

  const readRecord = options.readRecord || readCredentialRecord;
  const unprotect = options.unprotect || unprotectCredential;
  const runtimeRecord = readRecord(runtimePath, RUNTIME_ROLE);
  const ownerRecord = readRecord(ownerPath, OWNER_ROLE);
  const runtimePassword = unprotect(runtimeRecord.ciphertext);
  const ownerPassword = unprotect(ownerRecord.ciphertext);

  env.DATABASE_URL = withCredential(
    env.DATABASE_URL,
    RUNTIME_ROLE,
    runtimePassword,
    true
  );
  env.DIRECT_URL = withCredential(
    env.DIRECT_URL,
    OWNER_ROLE,
    ownerPassword,
    false
  );

  return { status: 'loaded', source: 'windows-dpapi-current-user' };
}

module.exports = {
  loadProtectedLocalDatabaseCredentials,
  withCredential,
};
