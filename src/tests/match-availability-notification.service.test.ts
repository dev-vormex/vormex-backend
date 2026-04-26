import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMatchAvailabilityCopy,
  scoreMatchRecommendation,
} from '../services/match-availability-notification.service';

function createUser(overrides: Record<string, any> = {}) {
  return {
    college: 'BITS Pilani',
    createdAt: new Date('2026-04-22T09:00:00.000Z'),
    id: 'user-1',
    interests: ['AI', 'Startups'],
    isBanned: false,
    lastActiveAt: new Date('2026-04-22T08:00:00.000Z'),
    name: 'Yash',
    skills: [
      {
        skill: {
          name: 'Kotlin',
        },
      },
      {
        skill: {
          name: 'React',
        },
      },
    ],
    user_onboarding: {
      primaryGoal: 'Build a startup',
    },
    ...overrides,
  };
}

test('scoreMatchRecommendation rewards same college, skills, interests, and goal', () => {
  const subjectUser = createUser();
  const recipientUser = createUser({
    id: 'user-2',
    interests: ['AI', 'Finance'],
    skills: [
      {
        skill: {
          name: 'Kotlin',
        },
      },
    ],
  });

  const recommendation = scoreMatchRecommendation(
    subjectUser as any,
    recipientUser as any,
    new Date('2026-04-22T10:00:00.000Z')
  );

  assert.equal(recommendation.sameCollege, true);
  assert.equal(recommendation.sameGoal, true);
  assert.deepEqual(recommendation.sharedSkills, ['Kotlin']);
  assert.deepEqual(recommendation.sharedInterests, ['AI']);
  assert.equal(recommendation.primaryReason, 'same_college');
  assert.equal(recommendation.score, 80);
});

test('buildMatchAvailabilityCopy prefers same-college join copy for fresh signups', () => {
  const subjectUser = createUser({
    college: 'VIT Chennai',
    name: 'Ananya',
  });
  const recommendation = {
    primaryReason: 'same_college',
    reasonKeys: ['same_college'],
    sameCollege: true,
    sameGoal: false,
    score: 25,
    sharedInterests: [],
    sharedSkills: [],
  };

  const copy = buildMatchAvailabilityCopy(
    subjectUser as any,
    recommendation as any,
    'signup',
    new Date('2026-04-22T10:00:00.000Z')
  );

  assert.equal(copy.title, 'Someone from VIT Chennai just joined');
  assert.match(copy.body, /Ananya just joined Vormex from VIT Chennai/);
});

test('buildMatchAvailabilityCopy uses shared skills when college does not match', () => {
  const subjectUser = createUser({
    college: null,
    interests: [],
    name: 'Bolt',
    user_onboarding: {
      primaryGoal: null,
    },
  });
  const recommendation = {
    primaryReason: 'shared_skills',
    reasonKeys: ['shared_skills'],
    sameCollege: false,
    sameGoal: false,
    score: 36,
    sharedInterests: [],
    sharedSkills: ['Kotlin', 'React'],
  };

  const copy = buildMatchAvailabilityCopy(
    subjectUser as any,
    recommendation as any,
    'profile_update',
    new Date('2026-04-23T10:00:00.000Z')
  );

  assert.equal(copy.title, 'Kotlin and React match on Vormex');
  assert.match(copy.body, /now lines up with you on Kotlin and React/);
});

test('buildMatchAvailabilityCopy falls back to same-goal copy when that is the only signal', () => {
  const subjectUser = createUser({
    college: null,
    interests: [],
    skills: [],
    name: 'Nina',
    user_onboarding: {
      primaryGoal: 'Crack placements',
    },
  });
  const recommendation = {
    primaryReason: 'same_goal',
    reasonKeys: ['same_goal'],
    sameCollege: false,
    sameGoal: true,
    score: 20,
    sharedInterests: [],
    sharedSkills: [],
  };

  const copy = buildMatchAvailabilityCopy(
    subjectUser as any,
    recommendation as any,
    'onboarding_update',
    new Date('2026-04-23T10:00:00.000Z')
  );

  assert.equal(copy.title, 'Crack placements match available');
  assert.match(copy.body, /shares your goal: Crack placements/);
});
