#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const allowedEntries = new Set(['api', 'worker', 'scheduler']);
const entryName = process.argv[2] || 'api';

if (!allowedEntries.has(entryName)) {
  console.error(`[start] Unsupported entry "${entryName}". Expected one of: ${Array.from(allowedEntries).join(', ')}.`);
  process.exit(1);
}

const compiledEntryPath = path.join(projectRoot, 'dist', `${entryName}.js`);

function runNpmScript(scriptName) {
  const result = spawnSync(npmCommand, ['run', scriptName], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (!fs.existsSync(compiledEntryPath)) {
  console.log(`[start] Missing dist/${entryName}.js. Running build before startup.`);
  runNpmScript('build');
}

require(compiledEntryPath);
