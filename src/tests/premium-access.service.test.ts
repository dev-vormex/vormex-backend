import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPremiumDaysRemaining,
  getPremiumPeriodEnd,
  isPremiumSubscriptionActive,
} from '../services/premium-access.service';

test('getPremiumPeriodEnd returns a date 31 days after the start date by default', () => {
  const start = new Date('2026-04-01T00:00:00.000Z');
  const end = getPremiumPeriodEnd(start);

  assert.equal(end.toISOString(), '2026-05-02T00:00:00.000Z');
});

test('isPremiumSubscriptionActive returns false when the subscription has expired', () => {
  const now = new Date('2026-05-03T00:00:00.000Z');
  const active = isPremiumSubscriptionActive(
    {
      plan: 'premium',
      status: 'active',
      currentPeriodEnd: new Date('2026-05-02T00:00:00.000Z'),
      cancelledAt: null,
    },
    now
  );

  assert.equal(active, false);
});

test('isPremiumSubscriptionActive returns false when the subscription was cancelled', () => {
  const now = new Date('2026-04-20T00:00:00.000Z');
  const active = isPremiumSubscriptionActive(
    {
      plan: 'premium',
      status: 'active',
      currentPeriodEnd: new Date('2026-05-02T00:00:00.000Z'),
      cancelledAt: new Date('2026-04-19T00:00:00.000Z'),
    },
    now
  );

  assert.equal(active, false);
});

test('getPremiumDaysRemaining rounds partial remaining days up', () => {
  const now = new Date('2026-04-20T12:00:00.000Z');
  const remaining = getPremiumDaysRemaining(new Date('2026-04-22T00:00:00.000Z'), now);

  assert.equal(remaining, 2);
});
