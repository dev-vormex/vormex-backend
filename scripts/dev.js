#!/usr/bin/env node

const path = require('path');
const { spawn, spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const projectRoot = path.join(__dirname, '..');
const databaseUrl = process.env.DATABASE_URL || '';
const shouldKeepDbAwake =
  process.env.AUTO_KEEP_DB_AWAKE !== 'false' &&
  /neon\.tech/i.test(databaseUrl);

const tsNodeDevBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'ts-node-dev.cmd' : 'ts-node-dev'
);

let serverProcess = null;
let keepAliveProcess = null;
let workerProcess = null;
let schedulerProcess = null;
let shuttingDown = false;

function spawnChild(command, args, name) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
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

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of [serverProcess, workerProcess, schedulerProcess, keepAliveProcess]) {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => process.exit(exitCode), 250);
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
  tsNodeDevBin,
  ['--respawn', '--transpile-only', 'src/api.ts'],
  'api server'
);

workerProcess = spawnChild(
  tsNodeDevBin,
  ['--respawn', '--transpile-only', 'src/worker.ts'],
  'worker'
);

schedulerProcess = spawnChild(
  tsNodeDevBin,
  ['--respawn', '--transpile-only', 'src/scheduler.ts'],
  'scheduler'
);

serverProcess.on('exit', (code, signal) => {
  if (shuttingDown) return;
  shutdown(signal ? 0 : code || 0);
});

for (const child of [workerProcess, schedulerProcess]) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    shutdown(signal ? 0 : code || 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
