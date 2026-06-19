import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMatchAvailabilityCopy,
  scoreMatchRecommendation,
} from '../services/match-availability-notification.service';
import {
  scoreUserMatch,
} from '../services/matching-engine.service';

function createUser(overrides: Record<string, any> = {}) {
  return {
    bio: 'Building useful software with friends.',
    branch: 'CSE',
    college: 'BITS Pilani',
    createdAt: new Date('2026-04-22T09:00:00.000Z'),
    currentCity: 'Pilani',
    currentCountry: 'India',
    currentState: 'Rajasthan',
    githubConnected: false,
    id: 'user-1',
    interests: ['AI', 'Startups'],
    isBanned: false,
    isOnline: false,
    isVerified: false,
    lastActiveAt: new Date('2026-04-22T08:00:00.000Z'),
    latitude: null,
    location: 'Pilani, India',
    locationPermission: true,
    longitude: null,
    name: 'Yash',
    onboardingCompleted: true,
    profileBadgeStyle: null,
    profileImage: null,
    shareLocationPublic: false,
    username: 'yash',
    graduationYear: 2027,
    headline: 'Kotlin builder',
    skills: [
      {
        proficiency: 'Advanced',
        yearsOfExp: 2,
        skill: {
          name: 'Kotlin',
        },
      },
      {
        proficiency: 'Intermediate',
        yearsOfExp: 1,
        skill: {
          name: 'React',
        },
      },
    ],
    user_goals: [
      {
        goal: 'Build a startup',
        category: 'career',
        priority: 1,
      },
    ],
    user_onboarding: {
      canTeach: ['Kotlin'],
      lookingFor: ['Co-founders'],
      primaryGoal: 'Build a startup',
      secondaryGoals: [],
      wantToLearn: ['Fundraising'],
      availability: 'weekends',
    },
    userStats: {
      connectionsCount: 4,
      xp: 120,
      level: 3,
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
  assert.ok(recommendation.sharedSkills.includes('Kotlin'));
  assert.deepEqual(recommendation.sharedInterests, ['AI']);
  assert.ok(recommendation.reasonKeys.includes('same_college'));
  assert.ok(recommendation.matchPercentage > 0);
  assert.match(recommendation.whySummary, /Yash|shares|lines up|chasing/);
});

test('skill complement outranks generic overlap', () => {
  const currentUser = createUser({
    id: 'current',
    skills: [
      {
        proficiency: 'Beginner',
        yearsOfExp: 1,
        skill: { name: 'React' },
      },
    ],
    user_onboarding: {
      canTeach: ['React'],
      lookingFor: ['Mentor'],
      primaryGoal: 'Launch a product',
      secondaryGoals: [],
      wantToLearn: ['Kotlin', 'Android'],
      availability: 'evenings',
    },
    user_goals: [{ goal: 'Launch a product', category: 'career', priority: 1 }],
  });
  const genericOverlap = createUser({
    id: 'generic',
    name: 'Generic',
    skills: [{ proficiency: null, yearsOfExp: null, skill: { name: 'React' } }],
    user_onboarding: {
      canTeach: ['React'],
      lookingFor: [],
      primaryGoal: null,
      secondaryGoals: [],
      wantToLearn: [],
      availability: null,
    },
    user_goals: [],
  });
  const mentor = createUser({
    id: 'mentor',
    name: 'Mentor',
    skills: [{ proficiency: null, yearsOfExp: null, skill: { name: 'Kotlin' } }],
    user_onboarding: {
      canTeach: ['Kotlin', 'Android'],
      lookingFor: [],
      primaryGoal: null,
      secondaryGoals: [],
      wantToLearn: [],
      availability: null,
    },
    user_goals: [],
  });

  const genericScore = scoreUserMatch(currentUser as any, genericOverlap as any);
  const mentorScore = scoreUserMatch(currentUser as any, mentor as any);

  assert.ok(mentorScore.skillScore > genericScore.skillScore);
  assert.ok(mentorScore.reasonKeys.includes('complementary_skills'));
});

test('location distance is ignored unless both users share public location', () => {
  const currentUser = createUser({
    id: 'current',
    college: null,
    currentCity: null,
    location: null,
    latitude: 12.9716,
    longitude: 77.5946,
    shareLocationPublic: true,
  });
  const privateCandidate = createUser({
    id: 'private',
    college: null,
    currentCity: null,
    location: null,
    latitude: 12.972,
    longitude: 77.595,
    shareLocationPublic: false,
  });

  const match = scoreUserMatch(currentUser as any, privateCandidate as any);

  assert.equal(match.sharedSignals.distanceKm, undefined);
  assert.equal(match.reasonKeys.includes('nearby'), false);
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
  assert.match(copy.body, /Ananya/);
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

  assert.equal(copy.title, 'Kotlin builder matched');
  assert.match(copy.body, /Bolt/);
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
  assert.match(copy.body, /Nina/);
});
