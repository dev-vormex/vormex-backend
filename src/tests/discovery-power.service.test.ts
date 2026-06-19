import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSavedSearchDigestCopy,
  hasPremiumPeopleDiscoveryFilters,
  normalizeIntentValues,
  sanitizeSavedSearchFilters,
  searchVariants,
} from '../services/discovery-power.service';

test('hasPremiumPeopleDiscoveryFilters allows basic free filters', () => {
  assert.equal(
    hasPremiumPeopleDiscoveryFilters({
      search: 'react',
      college: 'IIT Delhi',
      branch: 'CSE',
      graduationYear: '2026',
    }),
    false
  );
});

test('hasPremiumPeopleDiscoveryFilters detects advanced discovery filters', () => {
  assert.equal(hasPremiumPeopleDiscoveryFilters({ verifiedOnly: 'true' }), true);
  assert.equal(hasPremiumPeopleDiscoveryFilters({ scope: 'global' }), true);
  assert.equal(hasPremiumPeopleDiscoveryFilters({ skillLevel: 'advanced' }), true);
});

test('normalizeIntentValues expands product intent aliases', () => {
  const cofounder = normalizeIntentValues('co-founder');
  assert.ok(cofounder.includes('co-founder'));
  assert.ok(cofounder.includes('cofounder'));
  assert.ok(cofounder.includes('founder'));

  const collab = normalizeIntentValues('collab');
  assert.ok(collab.includes('collaboration'));
});

test('searchVariants includes lowercase, uppercase, and title-case values', () => {
  assert.deepEqual(searchVariants('dsa'), ['dsa', 'DSA', 'Dsa']);
});

test('sanitizeSavedSearchFilters keeps supported filters and drops unknown values', () => {
  assert.deepEqual(
    sanitizeSavedSearchFilters({
      search: '  AI builders  ',
      verifiedOnly: 'true',
      radiusKm: '50',
      lat: '12.9716',
      lng: '77.5946',
      adminOnly: 'nope',
    }),
    {
      search: 'AI builders',
      verifiedOnly: true,
      radiusKm: 50,
      lat: 12.9716,
      lng: 77.5946,
    }
  );
});

test('buildSavedSearchDigestCopy returns singular and plural copy', () => {
  assert.equal(buildSavedSearchDigestCopy('AI founders', 1).body, '1 new person matches AI founders');
  assert.equal(buildSavedSearchDigestCopy('AI founders', 3).body, '3 new people match AI founders');
});
