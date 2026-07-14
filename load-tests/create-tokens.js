#!/usr/bin/env node

/**
 * Create staging auth tokens for Vormex load tests.
 *
 * Registration now requires email OTP verification. This tool completes the
 * flow for throwaway users by planting a known OTP hash directly in the
 * database and then calling the real POST /api/auth/verify-email endpoint,
 * which returns a bearer token. It therefore needs the backend's .env
 * (DATABASE_URL + JWT_SECRET/AUTH_OTP_PEPPER) — run it from the repo on a
 * machine with staging DB access, never against production.
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const DEFAULT_COUNT = 5;
const DEFAULT_PASSWORD = process.env.LOAD_TEST_PASSWORD || 'LoadTest123!';
const KNOWN_OTP = '424242';

function printHelp() {
  console.log(`
Create staging auth tokens for Vormex load tests.

Usage:
  node load-tests/create-tokens.js --count 4

Options:
  --base-url <url>   API base URL. Default: ${DEFAULT_BASE_URL}
  --count <number>   Number of users/tokens to create. Default: ${DEFAULT_COUNT}
  --password <text>  Password for generated users. Default: ${DEFAULT_PASSWORD}
  --prefix <text>    Email prefix. Default: load-test
  --help             Show this help.

Notes:
  - Requires ../.env with DATABASE_URL and JWT_SECRET (or AUTH_OTP_PEPPER)
    matching the target backend, plus a compiled build (npm run build) so the
    OTP hashing util is available.
  - Auth writes are rate limited (~5 registrations / 10 min per IP, 10 OTP
    verifications / 15 min per IP). Keep --count at 5 or lower per run.
`);
}

function parseArgs(argv) {
  const args = {};

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = current.slice(2).split('=', 2);
    const nextValue = argv[index + 1];
    const value = inlineValue !== undefined
      ? inlineValue
      : nextValue && !nextValue.startsWith('--')
        ? nextValue
        : 'true';

    args[rawKey] = value;

    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
  }

  return args;
}

function toPositiveInt(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function loadOtpHasher() {
  try {
    // Compiled backend util so the hash matches the server exactly.
    // eslint-disable-next-line global-require
    const { hashEmailOtp } = require(path.join(__dirname, '..', 'dist', 'utils', 'auth-security.util.js'));
    return hashEmailOtp;
  } catch {
    throw new Error(
      'Could not load dist/utils/auth-security.util.js — run "npm run build" in vormex-backend first.'
    );
  }
}

async function apiRequest(baseUrl, method, apiPath, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${apiPath}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      // Ask for the token in the response body (non-browser transport).
      'x-auth-token-transport': 'bearer',
      'user-agent': 'vormex-load-test-token-generator/2.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }

  return { ok: response.ok, status: response.status, json };
}

async function createVerifiedUser(baseUrl, prisma, hashEmailOtp, body) {
  const register = await apiRequest(baseUrl, 'POST', '/api/auth/register', body);
  if (!register.ok) {
    throw new Error(
      `Failed to register ${body.email}: HTTP ${register.status} ${register.json.error || register.json.message || ''}`
    );
  }

  // Legacy path: some deployments may still return a token directly.
  if (register.json.token) {
    return register.json.token;
  }

  // Plant a known OTP so we can complete verification without email access.
  await prisma.user.update({
    where: { email: body.email },
    data: {
      verificationToken: hashEmailOtp(body.email, KNOWN_OTP),
      verificationTokenExpiry: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  const verify = await apiRequest(baseUrl, 'POST', '/api/auth/verify-email', {
    email: body.email,
    code: KNOWN_OTP,
  });

  if (!verify.ok || !verify.json.token) {
    throw new Error(
      `Failed to verify ${body.email}: HTTP ${verify.status} ${verify.json.error || verify.json.message || 'no token in response'}`
    );
  }

  return verify.json.token;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const baseUrl = args['base-url'] || DEFAULT_BASE_URL;
  const count = toPositiveInt(args.count, DEFAULT_COUNT, '--count');
  const password = args.password || DEFAULT_PASSWORD;
  const prefix = args.prefix || 'load-test';
  const runId = Date.now().toString(36);
  const tokens = [];

  const hashEmailOtp = loadOtpHasher();
  // eslint-disable-next-line global-require
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    for (let index = 0; index < count; index += 1) {
      const email = `${prefix}-${runId}-${index + 1}@example.com`;
      const token = await createVerifiedUser(baseUrl, prisma, hashEmailOtp, {
        email,
        password,
        name: `Load Test ${index + 1}`,
      });
      tokens.push(token);
      console.error(`created + verified ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`LOAD_TEST_TOKENS="${tokens.join(',')}"`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
