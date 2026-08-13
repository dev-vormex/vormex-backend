import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateAgentAccess,
  getAgentAccessDeniedMessage,
  getCreatorProPlanOptions,
  getPremiumDaysRemaining,
  getPremiumDurationDaysForBillingCycle,
  getPremiumPlanOptions,
  getPremiumPeriodEnd,
  isCreatorProSubscriptionActive,
  isLegacyTestPremiumSubscription,
  isPremiumSubscriptionActive,
  LEGACY_TEST_PREMIUM_PROVIDER,
} from '../services/premium-access.service';

test('getPremiumPeriodEnd returns a date 31 days after the start date by default', () => {
  const start = new Date('2026-04-01T00:00:00.000Z');
  const end = getPremiumPeriodEnd(start);

  assert.equal(end.toISOString(), '2026-05-02T00:00:00.000Z');
});

test('getPremiumDurationDaysForBillingCycle returns yearly access for yearly plans', () => {
  assert.equal(getPremiumDurationDaysForBillingCycle('yearly'), 365);
});

test('getPremiumPlanOptions exposes monthly and yearly premium offers', () => {
  const plans = getPremiumPlanOptions('INR');

  assert.deepEqual(
    plans.map((plan) => plan.billingCycle),
    ['monthly', 'yearly']
  );
  assert.equal(plans[0].amountMinor, 19900);
  assert.equal(plans[1].amountMinor, 99900);
});

test('getCreatorProPlanOptions exposes higher-priced creator offers', () => {
  const plans = getCreatorProPlanOptions('INR');

  assert.deepEqual(
    plans.map((plan) => plan.billingCycle),
    ['monthly', 'yearly']
  );
  assert.equal(plans[0].amountMinor, 49900);
  assert.equal(plans[1].amountMinor, 299900);
});

test('isPremiumSubscriptionActive returns false when the subscription has expired', () => {
  const now = new Date('2026-05-03T00:00:00.000Z');
  const active = isPremiumSubscriptionActive(
    {
      plan: 'premium',
      status: 'active',
      provider: 'razorpay',
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
      provider: 'razorpay',
      currentPeriodEnd: new Date('2026-05-02T00:00:00.000Z'),
      cancelledAt: new Date('2026-04-19T00:00:00.000Z'),
    },
    now
  );

  assert.equal(active, false);
});

test('creator pro subscriptions include premium access and creator pro access', () => {
  const now = new Date('2026-04-20T00:00:00.000Z');
  const subscription = {
    plan: 'creator_pro',
    status: 'active',
    provider: 'razorpay',
    currentPeriodEnd: new Date('2026-05-20T00:00:00.000Z'),
    cancelledAt: null,
  };

  assert.equal(isPremiumSubscriptionActive(subscription, now), true);
  assert.equal(isCreatorProSubscriptionActive(subscription, now), true);
});

test('leftover test premium rows never grant premium or creator pro access', () => {
  const now = new Date('2026-04-20T00:00:00.000Z');
  const subscription = {
    plan: 'creator_pro',
    status: 'active',
    provider: LEGACY_TEST_PREMIUM_PROVIDER,
    currentPeriodEnd: new Date('2027-04-20T00:00:00.000Z'),
    cancelledAt: null,
  };

  assert.equal(isLegacyTestPremiumSubscription(subscription), true);
  assert.equal(isPremiumSubscriptionActive(subscription, now), false);
  assert.equal(isCreatorProSubscriptionActive(subscription, now), false);
});

test('paid razorpay subscriptions are not treated as leftover test premium', () => {
  assert.equal(isLegacyTestPremiumSubscription({ provider: 'razorpay' }), false);
  assert.equal(isLegacyTestPremiumSubscription({ provider: 'google_play' }), false);
  assert.equal(isLegacyTestPremiumSubscription(null), false);
});

test('getPremiumDaysRemaining rounds partial remaining days up', () => {
  const now = new Date('2026-04-20T12:00:00.000Z');
  const remaining = getPremiumDaysRemaining(new Date('2026-04-22T00:00:00.000Z'), now);

  assert.equal(remaining, 2);
});

test('evaluateAgentAccess keeps the agent premium-only for non-admin free users', () => {
  const access = evaluateAgentAccess({
    isAdmin: false,
    isPremium: false,
    agentMode: 'all',
    agentEnabled: false,
    agentBlocked: false,
    creditsUsed: 0,
    agentPromptLimit: 3,
  });

  assert.equal(access.canUseAgent, false);
  assert.equal(access.agentLimitReached, false);
});

test('evaluateAgentAccess does not let selected-mode overrides grant free agent access', () => {
  const access = evaluateAgentAccess({
    isAdmin: false,
    isPremium: false,
    agentMode: 'selected',
    agentEnabled: true,
    agentBlocked: false,
    creditsUsed: 0,
    agentPromptLimit: 3,
  });

  assert.equal(access.canUseAgent, false);
  assert.equal(access.agentLimitReached, false);
});

test('evaluateAgentAccess lets admins bypass the prompt limit', () => {
  const access = evaluateAgentAccess({
    isAdmin: true,
    isPremium: false,
    agentMode: 'all',
    agentEnabled: false,
    agentBlocked: false,
    creditsUsed: 999,
    agentPromptLimit: 3,
  });

  assert.equal(access.canUseAgent, true);
  assert.equal(access.agentLimitReached, false);
});

test('evaluateAgentAccess lets premium users bypass the free prompt limit', () => {
  const access = evaluateAgentAccess({
    isAdmin: false,
    isPremium: true,
    agentMode: 'all',
    agentEnabled: false,
    agentBlocked: false,
    creditsUsed: 999,
    agentPromptLimit: 5,
  });

  assert.equal(access.canUseAgent, true);
  assert.equal(access.agentLimitReached, false);
});

test('getAgentAccessDeniedMessage mentions the prompt cap when the quota is exhausted', () => {
  const message = getAgentAccessDeniedMessage({
    agentLimitReached: true,
    agentPromptLimit: 5,
  });

  assert.match(message, /5 prompts/);
});

test('getAgentAccessDeniedMessage points free users to Premium Power Mode', () => {
  const message = getAgentAccessDeniedMessage({
    agentLimitReached: false,
    agentPromptLimit: 5,
  });

  assert.match(message, /Premium feature/);
  assert.match(message, /Power Mode/);
});
