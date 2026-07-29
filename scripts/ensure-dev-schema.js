#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const prismaCliPath = path.join(
  projectRoot,
  'node_modules',
  'prisma',
  'build',
  'index.js'
);

const sqlFiles = [
  path.join(
    projectRoot,
    'prisma',
    'migrations',
    '20260408153000_add_admin_premium_access_blocks',
    'migration.sql'
  ),
  path.join(
    projectRoot,
    'prisma',
    'migrations',
    '20260408190000_add_outbox_events_and_scaling_indexes',
    'migration.sql'
  ),
];

for (const sqlFile of sqlFiles) {
  const result = spawnSync(
    process.execPath,
    [prismaCliPath, 'db', 'execute', '--schema', 'prisma/schema.prisma', '--file', sqlFile],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    }
  );

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
