#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
const tscCli = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const srcOpenApiPath = path.join(projectRoot, 'src', 'openapi.yaml');
const distDir = path.join(projectRoot, 'dist');
const distOpenApiPath = path.join(distDir, 'openapi.yaml');

function runNodeScript(scriptPath, args, label) {
  if (!fs.existsSync(scriptPath)) {
    console.error(`[build] Missing ${label} executable at ${scriptPath}.`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

runNodeScript(prismaCli, ['generate'], 'Prisma CLI');
runNodeScript(tscCli, ['-p', 'tsconfig.json'], 'TypeScript compiler');

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(srcOpenApiPath, distOpenApiPath);

console.log(`[build] Copied ${path.relative(projectRoot, srcOpenApiPath)} -> ${path.relative(projectRoot, distOpenApiPath)}`);
