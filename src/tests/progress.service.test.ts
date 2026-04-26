import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateLevelProgress,
  isMeaningfulActivity,
  xpForLevel,
} from '../services/progress.service';

test('xpForLevel uses an open-ended level curve with level 1 at zero XP', () => {
  assert.equal(xpForLevel(1), 0);
  assert.equal(xpForLevel(2), 100);
  assert.equal(xpForLevel(3), Math.round(100 * Math.pow(2, 1.35)));
  assert.ok(xpForLevel(101) > xpForLevel(100));
});

test('calculateLevelProgress returns bounded progress and xp to next level', () => {
  const levelTwoStart = xpForLevel(2);
  const levelThreeStart = xpForLevel(3);
  const progress = calculateLevelProgress(levelTwoStart + 10);

  assert.equal(progress.lifetimeXp, levelTwoStart + 10);
  assert.equal(progress.level, 2);
  assert.equal(progress.currentLevelXp, levelTwoStart);
  assert.equal(progress.nextLevelXp, levelThreeStart);
  assert.equal(progress.xpIntoLevel, 10);
  assert.equal(progress.xpToNextLevel, levelThreeStart - levelTwoStart - 10);
  assert.ok(progress.progressToNextLevel > 0);
  assert.ok(progress.progressToNextLevel < 1);
});

test('login does not qualify as meaningful daily activity', () => {
  assert.equal(isMeaningfulActivity('login'), false);
  assert.equal(isMeaningfulActivity('post'), true);
  assert.equal(isMeaningfulActivity('comment'), true);
  assert.equal(isMeaningfulActivity('message'), true);
  assert.equal(isMeaningfulActivity('connection'), true);
});
