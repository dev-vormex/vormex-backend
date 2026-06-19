import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPremiumRequiredPayload,
  getPremiumProfileCustomizationFields,
  hasPremiumEntitlement,
  hasPremiumProfileCustomizationUpdate,
} from '../services/premium-feature-gates.service';

test('hasPremiumEntitlement allows premium, creator pro, and admin users', () => {
  assert.equal(
    hasPremiumEntitlement({ isPremium: true, isCreatorPro: false, user: { isAdmin: false } as any }),
    true
  );
  assert.equal(
    hasPremiumEntitlement({ isPremium: false, isCreatorPro: true, user: { isAdmin: false } as any }),
    true
  );
  assert.equal(
    hasPremiumEntitlement({ isPremium: false, isCreatorPro: false, user: { isAdmin: true } as any }),
    true
  );
});

test('hasPremiumEntitlement blocks free non-admin users', () => {
  assert.equal(
    hasPremiumEntitlement({ isPremium: false, isCreatorPro: false, user: { isAdmin: false } as any }),
    false
  );
});

test('premium required payload includes stable feature and code fields', () => {
  assert.deepEqual(buildPremiumRequiredPayload('discovery_rewind'), {
    success: false,
    error: 'Premium is required to rewind skipped discovery suggestions.',
    code: 'premium_required',
    feature: 'discovery_rewind',
    title: 'Discovery rewind',
  });
});

test('profile customization detector only catches premium styling fields', () => {
  const body = {
    name: 'Ada',
    headline: 'Builder',
    profileTheme: 'game_retro',
    profileBadgeStyle: 'professional',
  };

  assert.equal(hasPremiumProfileCustomizationUpdate(body), true);
  assert.deepEqual(getPremiumProfileCustomizationFields(body), [
    'profileTheme',
    'profileBadgeStyle',
  ]);
  assert.equal(hasPremiumProfileCustomizationUpdate({ name: 'Ada' }), false);
});
