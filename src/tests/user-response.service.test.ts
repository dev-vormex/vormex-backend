import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfileCustomizationResponseFields } from '../services/user-response.service';

test('profile customization response fields are preserved for entitled users', () => {
  assert.deepEqual(
    buildProfileCustomizationResponseFields(
      {
        profileBadgeStyle: 'professional',
        profileTheme: 'game_retro',
        profileRing: 'neon',
        visitLoaderGiftId: 'morty_dance',
      },
      true
    ),
    {
      profileBadgeStyle: 'professional',
      profileTheme: 'game_retro',
      profileRing: 'neon',
      visitLoaderGiftId: 'morty_dance',
    }
  );
});

test('profile customization response fields are hidden for non-entitled users', () => {
  assert.deepEqual(
    buildProfileCustomizationResponseFields(
      {
        profileBadgeStyle: 'professional',
        profileTheme: 'game_retro',
        profileRing: 'neon',
        visitLoaderGiftId: 'morty_dance',
      },
      false
    ),
    {
      profileBadgeStyle: null,
      profileTheme: 'default',
      profileRing: null,
      visitLoaderGiftId: null,
    }
  );
});

test('profile customization response exposes earned student badge for verified students', () => {
  assert.deepEqual(
    buildProfileCustomizationResponseFields(
      {
        profileBadgeStyle: 'student',
        profileTheme: 'game_retro',
        profileRing: 'neon',
        visitLoaderGiftId: 'morty_dance',
        identityTrustLevel: 'STUDENT_VERIFIED',
      },
      false
    ),
    {
      profileBadgeStyle: 'student',
      profileTheme: 'default',
      profileRing: null,
      visitLoaderGiftId: null,
    }
  );
});
