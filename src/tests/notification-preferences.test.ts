import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyNotificationSettings } from '../modules/notifications/services/preferences.service';
import {
  defaultNotificationPreferences,
  validatePreferencePatch,
  notificationCategoryEnabled,
  isNotificationQuietTime,
} from '../modules/notifications/services/preferences-policy.service';

test('preferences reject unknown keys, non-booleans, invalid times, and time zones', () => {
  assert.throws(() => validatePreferencePatch({ isAdmin: true }), /Unknown preference/);
  assert.throws(() => validatePreferencePatch({ pushEnabled: 'false' }), /Invalid preference/);
  assert.throws(() => validatePreferencePatch({ quietHoursStart: '25:00' }), /HH:mm/);
  assert.throws(() => validatePreferencePatch({ timeZone: 'invalid-zone' }), /time zone/);
  assert.deepEqual(validatePreferencePatch({ likesEnabled: false }), { likes: false });
});

test('quiet hours support midnight crossings in the saved user time zone', () => {
  const settings = { ...defaultNotificationPreferences, quietHoursEnabled: true, timeZone: 'Asia/Kolkata' };
  assert.equal(isNotificationQuietTime(settings, new Date('2026-10-22T17:00:00Z')), true);
  assert.equal(isNotificationQuietTime(settings, new Date('2026-10-22T06:00:00Z')), false);
  assert.equal(
    isNotificationQuietTime(
      { ...settings, quietHoursStart: '08:00', quietHoursEnd: '10:00' },
      new Date('2026-10-22T03:00:00Z')
    ),
    true
  );
});

test('category preferences disable corresponding notifications without suppressing unknown security types', () => {
  const settings = { ...defaultNotificationPreferences, likes: false, groups: false };
  assert.equal(notificationCategoryEnabled(settings, 'reel_like'), false);
  assert.equal(notificationCategoryEnabled(settings, 'GROUP_INVITE'), false);
  assert.equal(notificationCategoryEnabled(settings, 'connection_accepted'), true);
  assert.equal(notificationCategoryEnabled(settings, 'security_alert'), true);
});

test('legacy settings can round-trip the GET response and update digest aliases', () => {
  assert.deepEqual(
    validatePreferencePatch(legacyNotificationSettings(defaultNotificationPreferences)),
    defaultNotificationPreferences
  );
  assert.deepEqual(validatePreferencePatch({ dailyDigestEnabled: false, weeklySummaryEnabled: true }), {
    emailDigestFrequency: 'weekly',
  });
  assert.deepEqual(validatePreferencePatch({ connections: true, followsEnabled: false }), { connections: true });
  assert.throws(() => validatePreferencePatch({ dailyDigestEnabled: true, weeklySummaryEnabled: true }), /one digest/);
});
