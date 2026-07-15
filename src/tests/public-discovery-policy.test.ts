import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPublicUserEligible,
  normalizeDiscoveryList,
  normalizeDiscoveryText,
  tokenizeDiscoveryIntent,
} from '../services/public-discovery.service';

const eligibleUser = {
  isBanned: false,
  safetyRestrictedUntil: null,
  safetySuspendedUntil: null,
  webDiscoveryEnabled: true,
  aiDiscoveryEnabled: true,
  username: 'builder',
  name: 'Vormex Builder',
};

test('public discovery eligibility respects independent web and AI opt-outs', () => {
  assert.equal(isPublicUserEligible({ ...eligibleUser, webDiscoveryEnabled: false }, 'web'), false);
  assert.equal(isPublicUserEligible({ ...eligibleUser, webDiscoveryEnabled: false }, 'ai'), true);
  assert.equal(isPublicUserEligible({ ...eligibleUser, aiDiscoveryEnabled: false }, 'ai'), false);
});

test('public discovery excludes banned and actively safety-restricted members', () => {
  assert.equal(isPublicUserEligible({ ...eligibleUser, isBanned: true }, 'web'), false);
  assert.equal(isPublicUserEligible({ ...eligibleUser, safetyRestrictedUntil: new Date(Date.now() + 60_000) }, 'ai'), false);
  assert.equal(isPublicUserEligible({ ...eligibleUser, safetySuspendedUntil: new Date(Date.now() + 60_000) }, 'ai'), false);
});

test('discovery input is bounded, normalized, and expands goal intent', () => {
  assert.equal(normalizeDiscoveryText('  learn\u0000   coding  '), 'learn coding');
  assert.deepEqual(normalizeDiscoveryList(['AI', 'ai', ' Machine Learning ']), ['ai', 'machine learning']);
  const tokens = tokenizeDiscoveryIntent({ goal: 'I want to learn coding' });
  assert.ok(tokens.includes('programming'));
  assert.ok(tokens.includes('mentor'));
});
