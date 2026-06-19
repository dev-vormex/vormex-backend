import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const locationControllerPath = path.join(process.cwd(), 'src/controllers/location.controller.ts');
const discoveryPowerPath = path.join(process.cwd(), 'src/services/discovery-power.service.ts');
const migrationPath = path.join(
  process.cwd(),
  'prisma/migrations/20260608160000_make_location_public_opt_in/migration.sql',
);

test('storing location does not implicitly opt the user into public nearby', () => {
  const source = fs.readFileSync(locationControllerPath, 'utf8');
  const updateLocationBlock = source.slice(
    source.indexOf('export const updateLocation'),
    source.indexOf('/**\n * Update location settings')
  );

  assert.match(updateLocationBlock, /latitude:\s*lat/);
  assert.match(updateLocationBlock, /longitude:\s*lng/);
  assert.doesNotMatch(updateLocationBlock, /shareLocationPublic\s*:/);
});

test('public nearby visibility requires explicit opt in through settings', () => {
  const source = fs.readFileSync(locationControllerPath, 'utf8');
  const settingsBlock = source.slice(
    source.indexOf('export const updateLocationSettings'),
    source.indexOf('/**\n * Get current location')
  );
  const nearbyBlock = source.slice(
    source.indexOf('export const getNearbyUsers'),
    source.indexOf('/**\n * Update user location')
  );

  assert.match(settingsBlock, /shareLocationPublic\s*!==\s*undefined/);
  assert.match(settingsBlock, /typeof shareLocationPublic !== 'boolean'/);
  assert.match(settingsBlock, /shareLocationPublic:\s*shareLocationPublic \?\? undefined/);
  assert.match(nearbyBlock, /"shareLocationPublic"\s*=\s*true/);
});

test('discovery nearby search excludes users who have not opted in', () => {
  const source = fs.readFileSync(discoveryPowerPath, 'utf8');

  assert.match(source, /"shareLocationPublic"\s*=\s*true/);
  assert.match(source, /COALESCE\("locationPermission", true\)\s*=\s*true/);
});

test('location visibility migration resets historical implicit opt-ins to private', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /UPDATE "users"/);
  assert.match(sql, /SET "shareLocationPublic" = false/);
  assert.match(sql, /WHERE "shareLocationPublic" = true/);
});
