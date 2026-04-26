import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReengagementCopy,
  getConfiguredReengagementSlots,
  getCurrentReengagementWindow,
  getMeaningfulGrowthCount,
  hasMeaningfulGrowth,
  parseReengagementHours,
} from '../services/reengagement-notification.service';

test('parseReengagementHours keeps order, removes duplicates, and ignores invalid values', () => {
  const hours = parseReengagementHours('15, 18, 21, 21, nope, 25, 0');

  assert.deepEqual(hours, [15, 18, 21, 0]);
});

test('getCurrentReengagementWindow resolves the 3 PM IST slot from UTC time', () => {
  const previous = process.env.REENGAGEMENT_SLOT_HOURS_IST;
  const previousCap = process.env.REENGAGEMENT_MAX_PER_DAY;
  process.env.REENGAGEMENT_SLOT_HOURS_IST = '15,16,17,18,19,20,21,22,23,0';
  process.env.REENGAGEMENT_MAX_PER_DAY = '10';

  try {
    const window = getCurrentReengagementWindow(new Date('2026-04-22T09:30:00.000Z'));

    assert.equal(window.currentIstHour, 15);
    assert.equal(window.slot?.key, 'ist_15');
    assert.equal(window.slotDateKey, '2026-04-22');
  } finally {
    if (previous === undefined) {
      delete process.env.REENGAGEMENT_SLOT_HOURS_IST;
    } else {
      process.env.REENGAGEMENT_SLOT_HOURS_IST = previous;
    }
    if (previousCap === undefined) {
      delete process.env.REENGAGEMENT_MAX_PER_DAY;
    } else {
      process.env.REENGAGEMENT_MAX_PER_DAY = previousCap;
    }
  }
});

test('getCurrentReengagementWindow treats midnight IST as the previous campaign day final slot', () => {
  const previous = process.env.REENGAGEMENT_SLOT_HOURS_IST;
  const previousCap = process.env.REENGAGEMENT_MAX_PER_DAY;
  process.env.REENGAGEMENT_SLOT_HOURS_IST = '15,16,17,18,19,20,21,22,23,0';
  process.env.REENGAGEMENT_MAX_PER_DAY = '10';

  try {
    const window = getCurrentReengagementWindow(new Date('2026-04-22T18:30:00.000Z'));

    assert.equal(window.currentIstHour, 0);
    assert.equal(window.slot?.key, 'ist_00');
    assert.equal(window.slotDateKey, '2026-04-22');
  } finally {
    if (previous === undefined) {
      delete process.env.REENGAGEMENT_SLOT_HOURS_IST;
    } else {
      process.env.REENGAGEMENT_SLOT_HOURS_IST = previous;
    }
    if (previousCap === undefined) {
      delete process.env.REENGAGEMENT_MAX_PER_DAY;
    } else {
      process.env.REENGAGEMENT_MAX_PER_DAY = previousCap;
    }
  }
});

test('buildReengagementCopy uses the zero-growth nudge for stalled users', () => {
  const previous = process.env.REENGAGEMENT_SLOT_HOURS_IST;
  const previousCap = process.env.REENGAGEMENT_MAX_PER_DAY;
  process.env.REENGAGEMENT_SLOT_HOURS_IST = '15,16,17,18,19,20,21,22,23,0';
  process.env.REENGAGEMENT_MAX_PER_DAY = '10';

  try {
    const slot = getConfiguredReengagementSlots()[5];
    const copy = buildReengagementCopy({
      candidate: null,
      currentUser: {
        college: 'VIT',
        connectionsCount: 0,
        createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        meaningfulGrowthCount: 0,
        postsCount: 0,
        totalActiveDays: 1,
        user_onboarding: {
          primaryGoal: 'Build a startup',
        },
      },
      highestStreak: 0,
      slot,
    });

    assert.equal(copy.campaignType, 'growth');
    assert.match(copy.title, /0 today/);
    assert.match(copy.body, /No new posts/);
  } finally {
    if (previous === undefined) {
      delete process.env.REENGAGEMENT_SLOT_HOURS_IST;
    } else {
      process.env.REENGAGEMENT_SLOT_HOURS_IST = previous;
    }
    if (previousCap === undefined) {
      delete process.env.REENGAGEMENT_MAX_PER_DAY;
    } else {
      process.env.REENGAGEMENT_MAX_PER_DAY = previousCap;
    }
  }
});

test('buildReengagementCopy escalates the final slot when a streak is at risk', () => {
  const previous = process.env.REENGAGEMENT_SLOT_HOURS_IST;
  const previousCap = process.env.REENGAGEMENT_MAX_PER_DAY;
  process.env.REENGAGEMENT_SLOT_HOURS_IST = '15,16,17,18,19,20,21,22,23,0';
  process.env.REENGAGEMENT_MAX_PER_DAY = '10';

  try {
    const slot = getConfiguredReengagementSlots()[9];
    const copy = buildReengagementCopy({
      candidate: null,
      currentUser: {
        college: 'VIT',
        connectionsCount: 1,
        createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        meaningfulGrowthCount: 0,
        postsCount: 1,
        totalActiveDays: 7,
        user_onboarding: {
          primaryGoal: 'Crack placements',
        },
      },
      highestStreak: 4,
      slot,
    });

    assert.equal(copy.campaignType, 'streak');
    assert.match(copy.title, /Last call/);
    assert.match(copy.body, /4-day streak/);
  } finally {
    if (previous === undefined) {
      delete process.env.REENGAGEMENT_SLOT_HOURS_IST;
    } else {
      process.env.REENGAGEMENT_SLOT_HOURS_IST = previous;
    }
    if (previousCap === undefined) {
      delete process.env.REENGAGEMENT_MAX_PER_DAY;
    } else {
      process.env.REENGAGEMENT_MAX_PER_DAY = previousCap;
    }
  }
});

test('buildReengagementCopy bases zero-growth nudges on today, not lifetime totals', () => {
  const previous = process.env.REENGAGEMENT_SLOT_HOURS_IST;
  const previousCap = process.env.REENGAGEMENT_MAX_PER_DAY;
  process.env.REENGAGEMENT_SLOT_HOURS_IST = '15,16,17,18,19,20,21,22,23,0';
  process.env.REENGAGEMENT_MAX_PER_DAY = '10';

  try {
    const slot = getConfiguredReengagementSlots()[5];
    const copy = buildReengagementCopy({
      candidate: null,
      currentUser: {
        college: 'VIT',
        connectionsCount: 8,
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        meaningfulGrowthCount: 0,
        postsCount: 12,
        totalActiveDays: 18,
        user_onboarding: {
          primaryGoal: 'Build a startup',
        },
      },
      highestStreak: 0,
      slot,
    });

    assert.equal(copy.campaignType, 'growth');
    assert.match(copy.title, /0 today/);
  } finally {
    if (previous === undefined) {
      delete process.env.REENGAGEMENT_SLOT_HOURS_IST;
    } else {
      process.env.REENGAGEMENT_SLOT_HOURS_IST = previous;
    }
    if (previousCap === undefined) {
      delete process.env.REENGAGEMENT_MAX_PER_DAY;
    } else {
      process.env.REENGAGEMENT_MAX_PER_DAY = previousCap;
    }
  }
});

test('hasMeaningfulGrowth stays false for users who only opened the app', () => {
  const snapshot = {
    acceptedConnections: 0,
    directMessages: 0,
    groupMessages: 0,
    postComments: 0,
    postsCreated: 0,
    reelComments: 0,
    reelsCreated: 0,
  };

  assert.equal(getMeaningfulGrowthCount(snapshot), 0);
  assert.equal(hasMeaningfulGrowth(snapshot), false);
});

test('hasMeaningfulGrowth becomes true after any meaningful action', () => {
  const snapshot = {
    acceptedConnections: 1,
    directMessages: 0,
    groupMessages: 2,
    postComments: 0,
    postsCreated: 0,
    reelComments: 0,
    reelsCreated: 0,
  };

  assert.equal(getMeaningfulGrowthCount(snapshot), 3);
  assert.equal(hasMeaningfulGrowth(snapshot), true);
});
