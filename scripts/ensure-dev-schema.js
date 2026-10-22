#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(projectRoot, '.env') });
require('./local-neon-credentials').loadProtectedLocalDatabaseCredentials();
const prismaCliPath = path.join(
  projectRoot,
  'node_modules',
  'prisma',
  'build',
  'index.js'
);

const sqlFiles = [
  // Keep new runtime columns available before the API accepts requests.
  path.join(projectRoot, 'prisma/migrations/20260814120000_add_personalized_home_feed/migration.sql'),
  // Only schema here: the full security migration also changes verification
  // records and coin balances, which must not run on every development boot.
  path.join(projectRoot, 'scripts/sql/ensure-runtime-columns.sql'),
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
