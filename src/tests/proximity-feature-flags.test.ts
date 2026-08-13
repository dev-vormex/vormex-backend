import assert from 'node:assert/strict';
import test from 'node:test';
import { getProximityFeatureFlagsForUser } from '../services/proximity-feature-flags.service';

const legacyKeys = [
  'CROSSED_PATHS_ENTRY_ENABLED',
  'CROSSED_PATHS_EVENT_MODE_ENABLED',
  'CROSSED_PATHS_PUBLIC_PRESENCE_ENABLED',
  'CROSSED_PATHS_LIVE_MAP_ENABLED',
  'CROSSED_PATHS_LIVE_LIST_ENABLED',
  'CROSSED_PATHS_ACCUMULATION_ENABLED',
  'CROSSED_PATHS_SUMMARY_NOTIFICATIONS_ENABLED',
  'CROSSED_PATHS_PERSISTENCE_ENABLED',
];

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Crossed Paths stays enabled despite stale legacy rollout flags', () => {
  withEnvironment({
    CROSSED_PATHS_FORCE_DISABLED: 'false',
    PROXIMITY_ROLLOUT_PERCENT: '0',
    ...Object.fromEntries(legacyKeys.map((key) => [key, 'false'])),
  }, () => {
    const flags = getProximityFeatureFlagsForUser('user-1', 'install-1');
    assert.ok(Object.values(flags).every(Boolean));
  });
});

test('the emergency shutdown switch disables every proximity capability', () => {
  withEnvironment({ CROSSED_PATHS_FORCE_DISABLED: 'true' }, () => {
    const flags = getProximityFeatureFlagsForUser('user-1', 'install-1');
    assert.ok(Object.values(flags).every((value) => value === false));
  });
});
