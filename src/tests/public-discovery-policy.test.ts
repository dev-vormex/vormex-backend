import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPublicUserEligible,
  filterPublicProjectsForDiscovery,
  normalizeDiscoveryList,
  normalizeDiscoveryText,
  tokenizeDiscoveryIntent,
} from '../services/public-discovery.service';
import { tokenizePublicPostQuery } from '../services/public-content-discovery.service';

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

test('public post discovery expands broad hackathon and coding requests', () => {
  const hackathonTokens = tokenizePublicPostQuery('Show me upcoming hackathons');
  assert.ok(hackathonTokens.includes('hackathon'));
  assert.ok(hackathonTokens.includes('team'));
  assert.ok(hackathonTokens.includes('devfolio'));

  const codingTokens = tokenizePublicPostQuery('I want coding posts');
  assert.ok(codingTokens.includes('programming'));
  assert.ok(codingTokens.includes('developer'));
});

test('public discovery removes corrupted and exact duplicate projects', () => {
  const projects = filterPublicProjectsForDiscovery([
    { name: 'CreatorCircle', description: 'A collaboration platform for creators.', projectUrl: 'https://example.com/creator-circle' },
    { name: 'CreatorCircle', description: 'A collaboration platform for creators.', projectUrl: 'https://example.com/creator-circle' },
    { name: 'Vormex', description: "Explore Sanjay Baba's board '8k wallpaper' on Pinterest. See more ideas about studio background images.", projectUrl: 'https://pinterest.com/example' },
  ]);
  assert.deepEqual(projects.map((project) => project.name), ['CreatorCircle']);
});
