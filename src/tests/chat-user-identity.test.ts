import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatUserIdentity } from '../controllers/chat.controller';

test('chat user identity exposes premium badge state for premium users', () => {
  const user = buildChatUserIdentity(
    {
      id: 'premium-user',
      name: 'Premium User',
      profileBadgeStyle: 'professional',
    },
    new Map([
      [
        'premium-user',
        {
          isPremium: true,
        },
      ],
    ])
  );

  assert.equal(user.isPremium, true);
  assert.equal(user.profileBadgeStyle, 'professional');
});

test('chat user identity hides stale badge styles for free users', () => {
  const user = buildChatUserIdentity(
    {
      id: 'free-user',
      name: 'Free User',
      profileBadgeStyle: 'premium',
    },
    new Map()
  );

  assert.equal(user.isPremium, false);
  assert.equal(user.profileBadgeStyle, null);
});

test('chat user identity exposes earned student badge for verified students', () => {
  const user = buildChatUserIdentity(
    {
      id: 'student-user',
      name: 'Student User',
      profileBadgeStyle: 'student',
      identityTrustLevel: 'STUDENT_VERIFIED',
    },
    new Map()
  );

  assert.equal(user.isPremium, false);
  assert.equal(user.profileBadgeStyle, 'student');
  assert.deepEqual(user.verificationBadges, ['email', 'phone', 'student']);
});
