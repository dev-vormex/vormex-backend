import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from '../helpers/implementation-source';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('Android trusts core follow context without an extra profile-open request', () => {
  const viewModel = readFileSync(
    join(
      process.cwd(),
      '../vormex-android/catalog/src/main/java/com/kyant/backdrop/catalog/linkedin/ProfileViewModel.kt'
    ),
    'utf8'
  );

  assert.doesNotMatch(viewModel, /loadFollowStatus\(/);
  assert.match(viewModel, /isFollowing = mergedProfile\.viewerContext\.isFollowing/);
  assert.match(viewModel, /isFollowedBy = mergedProfile\.viewerContext\.isFollowedBy/);
});

test('public foreground presence uses the strict UUID heartbeat contract on both clients', () => {
  const controller = readFileSync(resolve(root, 'src/modules/proximity/controllers/proximity.controller.ts'), 'utf8');
  const androidCoordinator = readFileSync(
    resolve(
      root,
      '../vormex-android/catalog/src/main/java/com/kyant/backdrop/catalog/location/CrossedPathsForegroundPresenceCoordinator.kt'
    ),
    'utf8'
  );
  assert.doesNotMatch(controller, /`public-\$\{owner\}`/);
  assert.match(controller, /validateHeartbeat\(req\.body \|\| \{\}, sessionId\)/);
  assert.match(androidCoordinator, /UUID\.randomUUID\(\)\.toString\(\)/);
  assert.doesNotMatch(androidCoordinator, /"public-\$\{UUID\.randomUUID\(\)\}"/);
  assert.match(androidCoordinator, /pending: ProximityHeartbeatRequest\?/);
  assert.match(androidCoordinator, /pending = null/);
});
