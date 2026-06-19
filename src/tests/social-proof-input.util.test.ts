import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeActivityType,
  normalizeOptionalTrackingText,
  normalizeRequiredTrackingId,
  normalizeSocialProofMetadata,
} from '../utils/social-proof-input.util';

test('social proof tracking ids are required, trimmed, and structurally safe', () => {
  assert.deepEqual(normalizeRequiredTrackingId(' user-123 ', 'viewedId'), {
    ok: true,
    value: 'user-123',
  });

  assert.equal(normalizeRequiredTrackingId('', 'viewedId').ok, false);
  assert.equal(normalizeRequiredTrackingId('user;drop', 'viewedId').ok, false);
  assert.equal(normalizeRequiredTrackingId('x'.repeat(129), 'viewedId').ok, false);
});

test('social proof optional tracking text accepts route-like values and rejects markup', () => {
  assert.deepEqual(normalizeOptionalTrackingText('/profile/user-123', 'currentPage'), {
    ok: true,
    value: '/profile/user-123',
  });

  assert.deepEqual(normalizeOptionalTrackingText(undefined, 'source'), {
    ok: true,
    value: undefined,
  });

  assert.equal(normalizeOptionalTrackingText('<script>alert(1)</script>', 'source').ok, false);
});

test('social proof activity type and metadata are bounded primitives', () => {
  assert.deepEqual(normalizeActivityType(' profile_view '), {
    ok: true,
    value: 'profile_view',
  });

  assert.deepEqual(normalizeSocialProofMetadata({
    source: 'home',
    position: 3,
    recommended: true,
    note: null,
  }), {
    ok: true,
    value: {
      source: 'home',
      position: 3,
      recommended: true,
      note: null,
    },
  });

  assert.equal(normalizeActivityType('bad<script>').ok, false);
  assert.equal(normalizeSocialProofMetadata({ nested: { unsafe: true } }).ok, false);
  assert.equal(normalizeSocialProofMetadata({ long: 'x'.repeat(257) }).ok, false);
});
