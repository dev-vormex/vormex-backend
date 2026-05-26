#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const DEFAULT_COUNT = 5;
const DEFAULT_PASSWORD = process.env.LOAD_TEST_PASSWORD || 'LoadTest123!';

function printHelp() {
  console.log(`
Create staging auth tokens for Vormex load tests.

Usage:
  node load-tests/create-tokens.js --count 5

Options:
  --base-url <url>   API base URL. Default: ${DEFAULT_BASE_URL}
  --count <number>   Number of users/tokens to create. Default: ${DEFAULT_COUNT}
  --password <text>  Password for generated users. Default: ${DEFAULT_PASSWORD}
  --prefix <text>    Email prefix. Default: load-test
  --help             Show this help.

Note:
  The backend limits auth writes to 5 requests per 10 minutes per IP.
  Keep --count at 5 or lower unless you are using a staging-only limit override.
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

async function createUser(baseUrl, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/register`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'vormex-load-test-token-generator/1.0',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }

  if (!response.ok || !json.token) {
    throw new Error(
      `Failed to create ${body.email}: HTTP ${response.status} ${json.error || json.message || text}`
    );
  }

  return json.token;
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

  for (let index = 0; index < count; index += 1) {
    const email = `${prefix}-${runId}-${index + 1}@example.com`;
    const token = await createUser(baseUrl, {
      email,
      password,
      name: `Load Test ${index + 1}`,
    });
    tokens.push(token);
    console.error(`created ${email}`);
  }

  console.log(`LOAD_TEST_TOKENS="${tokens.join(',')}"`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
