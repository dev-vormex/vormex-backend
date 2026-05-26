import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getGooglePlayObfuscatedAccountId,
  type GooglePlayPremiumConfig,
  type GooglePlaySubscriptionPurchaseV2,
  validateGooglePlayPremiumPurchase,
} from '../services/google-play-premium.service';

const config: GooglePlayPremiumConfig = {
  packageName: 'com.vormex.android',
  productId: 'vormex_premium',
  monthlyBasePlanId: 'premium-monthly-prepaid',
  yearlyBasePlanId: 'premium-yearly-prepaid',
};

const now = new Date('2026-05-18T00:00:00.000Z');
const userId = 'user_123';

function purchaseFixture(
  overrides: Partial<GooglePlaySubscriptionPurchaseV2> = {},
  lineItemOverrides: Partial<NonNullable<GooglePlaySubscriptionPurchaseV2['lineItems']>[number]> = {}
): GooglePlaySubscriptionPurchaseV2 {
  return {
    startTime: '2026-05-18T00:00:00.000Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: getGooglePlayObfuscatedAccountId(userId),
    },
    lineItems: [
      {
        productId: config.productId,
        expiryTime: '2026-06-18T00:00:00.000Z',
        latestSuccessfulOrderId: 'GPA.1234-5678-9012-34567',
        offerDetails: {
          basePlanId: config.monthlyBasePlanId,
        },
        ...lineItemOverrides,
      },
    ],
    ...overrides,
  };
}

test('validateGooglePlayPremiumPurchase accepts an active monthly prepaid purchase', () => {
  const result = validateGooglePlayPremiumPurchase({
    userId,
    requestedProductId: config.productId,
    purchaseToken: 'token_monthly',
    purchase: purchaseFixture(),
    config,
    now,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.billingCycle, 'monthly');
    assert.equal(result.basePlanId, config.monthlyBasePlanId);
    assert.equal(result.orderId, 'GPA.1234-5678-9012-34567');
    assert.equal(result.currentPeriodEnd.toISOString(), '2026-06-18T00:00:00.000Z');
  }
});

test('validateGooglePlayPremiumPurchase maps the yearly prepaid base plan', () => {
  const result = validateGooglePlayPremiumPurchase({
    userId,
    requestedProductId: config.productId,
    purchaseToken: 'token_yearly',
    purchase: purchaseFixture(
      {},
      {
        expiryTime: '2027-05-18T00:00:00.000Z',
        offerDetails: {
          basePlanId: config.yearlyBasePlanId,
        },
      }
    ),
    config,
    now,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.billingCycle, 'yearly');
    assert.equal(result.currentPeriodEnd.toISOString(), '2027-05-18T00:00:00.000Z');
  }
});

test('validateGooglePlayPremiumPurchase rejects expired purchases', () => {
  const result = validateGooglePlayPremiumPurchase({
    userId,
    requestedProductId: config.productId,
    purchaseToken: 'token_expired',
    purchase: purchaseFixture(
      {},
      {
        expiryTime: '2026-05-17T23:59:59.000Z',
      }
    ),
    config,
    now,
  });

  assert.deepEqual(result, {
    ok: false,
    statusCode: 409,
    code: 'google_play_subscription_expired',
    error: 'Google Play Premium purchase has expired.',
  });
});

test('validateGooglePlayPremiumPurchase rejects pending and on-hold purchases', () => {
  for (const subscriptionState of [
    'SUBSCRIPTION_STATE_PENDING',
    'SUBSCRIPTION_STATE_ON_HOLD',
  ]) {
    const result = validateGooglePlayPremiumPurchase({
      userId,
      requestedProductId: config.productId,
      purchaseToken: `token_${subscriptionState}`,
      purchase: purchaseFixture({ subscriptionState }),
      config,
      now,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'google_play_subscription_not_active');
    }
  }
});

test('validateGooglePlayPremiumPurchase rejects mismatched products and base plans', () => {
  const productResult = validateGooglePlayPremiumPurchase({
    userId,
    requestedProductId: 'other_product',
    purchaseToken: 'token_product',
    purchase: purchaseFixture(),
    config,
    now,
  });

  assert.equal(productResult.ok, false);
  if (!productResult.ok) {
    assert.equal(productResult.code, 'google_play_product_mismatch');
  }

  const basePlanResult = validateGooglePlayPremiumPurchase({
    userId,
    requestedProductId: config.productId,
    purchaseToken: 'token_base_plan',
    purchase: purchaseFixture(
      {},
      {
        offerDetails: {
          basePlanId: 'unexpected-plan',
        },
      }
    ),
    config,
    now,
  });

  assert.equal(basePlanResult.ok, false);
  if (!basePlanResult.ok) {
    assert.equal(basePlanResult.code, 'google_play_base_plan_mismatch');
  }
});

test('validateGooglePlayPremiumPurchase rejects purchases for another Vormex account', () => {
  const result = validateGooglePlayPremiumPurchase({
    userId,
    requestedProductId: config.productId,
    purchaseToken: 'token_other_account',
    purchase: purchaseFixture({
      externalAccountIdentifiers: {
        obfuscatedExternalAccountId: getGooglePlayObfuscatedAccountId('other_user'),
      },
    }),
    config,
    now,
  });

  assert.deepEqual(result, {
    ok: false,
    statusCode: 403,
    code: 'google_play_account_mismatch',
    error: 'This Google Play purchase belongs to a different Vormex account.',
  });
});
