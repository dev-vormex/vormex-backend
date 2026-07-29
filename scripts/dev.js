#!/usr/bin/env node

const path = require('path');
const { spawn, spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { loadProtectedLocalDatabaseCredentials } = require('./local-neon-credentials');
const localCredentialResult = loadProtectedLocalDatabaseCredentials();
if (localCredentialResult.status === 'loaded') {
  console.log('[dev] Loaded Windows-protected local database credentials.');
}

const projectRoot = path.join(__dirname, '..');
const databaseUrl = process.env.DATABASE_URL || '';
const redisUrl = process.env.REDIS_URL || '';
const shouldKeepDbAwake =
  process.env.AUTO_KEEP_DB_AWAKE !== 'false' &&
  /neon\.tech/i.test(databaseUrl);
const backgroundJobsMode = (process.env.DEV_BACKGROUND_JOBS || 'auto').toLowerCase();

const tsxCliPath = path.join(
  projectRoot,
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs'
);

let serverProcess = null;
let keepAliveProcess = null;
let workerProcess = null;
let schedulerProcess = null;
let shuttingDown = false;
let forcedShutdownTimer = null;

function spawnChild(command, args, name) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });

  child.on('error', (error) => {
    console.error(`[dev] Failed to start ${name}:`, error.message);
    shutdown(1);
  });

  return child;
}

function runBootstrap(command, args, name) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    console.error(`[dev] ${name} failed with exit code ${result.status || 1}.`);
    process.exit(result.status || 1);
  }
}

function shouldStartBackgroundJobs() {
  if (['1', 'true', 'yes'].includes(backgroundJobsMode)) {
    return true;
  }

  if (['0', 'false', 'no'].includes(backgroundJobsMode)) {
    return false;
  }

  return Boolean(redisUrl) && !/upstash\.io/i.test(redisUrl);
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const children = [serverProcess, workerProcess, schedulerProcess, keepAliveProcess].filter(Boolean);

  for (const child of children) {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  }

  forcedShutdownTimer = setTimeout(() => {
    for (const child of children) {
      if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(exitCode);
  }, 8_000);

  Promise.allSettled(children.map(waitForExit)).then(() => {
    if (forcedShutdownTimer) clearTimeout(forcedShutdownTimer);
    process.exit(exitCode);
  });
}

if (shouldKeepDbAwake) {
  console.log('[dev] Neon database detected. Starting keep-alive helper.');
  keepAliveProcess = spawnChild(process.execPath, [path.join(__dirname, 'neon-keep-alive.js')], 'Neon keep-alive');

  keepAliveProcess.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.warn(
      `[dev] Neon keep-alive exited unexpectedly (${signal || code || 'unknown'}). ` +
      'The backend will continue, but the database may autosuspend.'
    );
  });
} else {
  console.log('[dev] Neon keep-alive skipped (DATABASE_URL is not Neon or AUTO_KEEP_DB_AWAKE=false).');
}

console.log('[dev] Ensuring required schema primitives exist.');
runBootstrap(process.execPath, [path.join(__dirname, 'ensure-dev-schema.js')], 'schema bootstrap');

serverProcess = spawnChild(
  process.execPath,
  [tsxCliPath, 'watch', 'src/api.ts'],
  'api server'
);

if (shouldStartBackgroundJobs()) {
  workerProcess = spawnChild(
    process.execPath,
    [tsxCliPath, 'watch', 'src/worker.ts'],
    'worker'
  );

  schedulerProcess = spawnChild(
    process.execPath,
    [tsxCliPath, 'watch', 'src/scheduler.ts'],
    'scheduler'
  );
} else {
  console.log(
    '[dev] Background workers skipped. Set DEV_BACKGROUND_JOBS=true to run BullMQ workers and schedulers.'
  );
}

serverProcess.on('exit', (code, signal) => {
  if (shuttingDown) return;
  shutdown(signal ? 0 : code || 0);
});

for (const child of [workerProcess, schedulerProcess].filter(Boolean)) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    shutdown(signal ? 0 : code || 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
