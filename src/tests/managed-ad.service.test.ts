import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_AD_SIDEBAR_SLOT_KEY,
  isManagedAdCtaAllowed,
  managedAdSlotsForItemCount,
  matchesManagedAdTargeting,
} from '../services/managed-ad.service';

const baseProfile = {
  colleges: ['vormex university'],
  branches: ['computer science'],
  years: [3, 2027],
  currentYears: [3],
  graduationYears: [2027],
  interests: ['startups', 'ai'],
  skills: ['kotlin', 'react'],
  primaryGoals: ['find_internship'],
  cities: ['bengaluru'],
  states: ['karnataka'],
  countries: ['india'],
  countryCodes: ['in'],
  premiumStates: ['creator_pro', 'premium'],
  verification: ['verified'],
  openToOpportunities: ['true'],
};

test('managed ad slots match feed and reels cadence', () => {
  assert.deepEqual(
    managedAdSlotsForItemCount('feed', 20).map((slot) => ({
      sequence: slot.sequence,
      afterItemCount: slot.afterItemCount,
      slotKey: slot.slotKey,
    })),
    [
      { sequence: 0, afterItemCount: 4, slotKey: 'feed_0' },
      { sequence: 1, afterItemCount: 12, slotKey: 'feed_1' },
      { sequence: 2, afterItemCount: 20, slotKey: 'feed_2' },
    ]
  );

  assert.deepEqual(
    managedAdSlotsForItemCount('reels', 20).map((slot) => ({
      sequence: slot.sequence,
      afterItemCount: slot.afterItemCount,
      slotKey: slot.slotKey,
    })),
    [
      { sequence: 0, afterItemCount: 5, slotKey: 'reels_0' },
      { sequence: 1, afterItemCount: 13, slotKey: 'reels_1' },
    ]
  );
});

test('managed ad slots support pagination offsets', () => {
  assert.deepEqual(
    managedAdSlotsForItemCount('feed', 40, 40).map((slot) => ({
      sequence: slot.sequence,
      afterItemCount: slot.afterItemCount,
      slotKey: slot.slotKey,
    })),
    [
      { sequence: 5, afterItemCount: 44, slotKey: 'feed_5' },
      { sequence: 6, afterItemCount: 52, slotKey: 'feed_6' },
      { sequence: 7, afterItemCount: 60, slotKey: 'feed_7' },
      { sequence: 8, afterItemCount: 68, slotKey: 'feed_8' },
      { sequence: 9, afterItemCount: 76, slotKey: 'feed_9' },
    ]
  );
});

test('sidebar is a single slot independent of item count and scroll offset', () => {
  const expected = [{
    placement: 'sidebar',
    sequence: 0,
    afterItemCount: 0,
    slotKey: MANAGED_AD_SIDEBAR_SLOT_KEY,
  }];

  // The rail is persistent, so it must not gain slots as the viewer scrolls,
  // and it must still resolve before any items have loaded.
  assert.deepEqual(managedAdSlotsForItemCount('sidebar', 0), expected);
  assert.deepEqual(managedAdSlotsForItemCount('sidebar', 20), expected);
  assert.deepEqual(managedAdSlotsForItemCount('sidebar', 40, 40), expected);
});

test('targeting include dimensions are ANDed and values within a dimension are ORed', () => {
  assert.equal(
    matchesManagedAdTargeting(
      {
        include: {
          colleges: ['Other University', 'Vormex University'],
          skills: ['Kotlin'],
          currentYears: [3],
          graduationYears: [2027],
        },
      },
      baseProfile
    ),
    true
  );

  assert.equal(
    matchesManagedAdTargeting(
      {
        include: {
          colleges: ['Vormex University'],
          skills: ['Swift'],
        },
      },
      baseProfile
    ),
    false
  );
});

test('targeting exclusions override includes', () => {
  assert.equal(
    matchesManagedAdTargeting(
      {
        include: { colleges: ['Vormex University'], skills: ['Kotlin'] },
        exclude: { cities: ['Bengaluru'] },
      },
      baseProfile
    ),
    false
  );
});

test('premium, verification, and opportunity targeting match profile states', () => {
  assert.equal(
    matchesManagedAdTargeting(
      {
        include: {
          premiumStates: ['creator_pro'],
          verification: ['verified'],
          openToOpportunities: true,
        },
      },
      baseProfile
    ),
    true
  );

  assert.equal(
    matchesManagedAdTargeting(
      {
        include: {
          premiumStates: ['free'],
        },
      },
      baseProfile
    ),
    false
  );
});

test('cta validation allows https external URLs and approved Vormex deeplinks only', () => {
  assert.equal(isManagedAdCtaAllowed('external_url', 'https://example.com/path'), true);
  assert.equal(isManagedAdCtaAllowed('external_url', 'http://example.com/path'), false);
  assert.equal(isManagedAdCtaAllowed('vormex_deeplink', 'vormex://reels/abc'), true);
  assert.equal(isManagedAdCtaAllowed('vormex_deeplink', 'https://vormex.in/post/abc'), true);
  assert.equal(isManagedAdCtaAllowed('vormex_deeplink', 'https://evil.example/post/abc'), false);
});
