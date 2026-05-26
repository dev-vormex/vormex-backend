import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type PremiumPlanConfig,
  validatePremiumCheckoutPayment,
  verifyRazorpaySignature,
} from '../services/premium-checkout.service';

const baseConfig: PremiumPlanConfig = {
  amountMinor: 19900,
  currency: 'INR',
  plan: 'premium',
  billingCycle: 'monthly',
};

const baseOrder = {
  id: 'order_123',
  amount: 19900,
  amount_paid: 19900,
  amount_due: 0,
  currency: 'INR',
  status: 'paid',
  notes: {
    userId: 'user_123',
    plan: 'premium',
    billingCycle: 'monthly',
  },
};

const basePayment = {
  id: 'pay_123',
  amount: 19900,
  amount_refunded: 0,
  captured: true,
  currency: 'INR',
  order_id: 'order_123',
  refund_status: null,
  status: 'captured',
};

test('verifyRazorpaySignature accepts a valid server-generated signature', () => {
  const secret = 'secret_test_value';
  const signature = 'f869dc9f81bf848bea781fe8493c1573c8cadbf3498283b661b8567fda9d53e6';

  assert.equal(
    verifyRazorpaySignature('order_123', 'pay_123', signature, secret),
    true
  );
});

test('validatePremiumCheckoutPayment accepts a captured payment for the matching order and user', () => {
  const result = validatePremiumCheckoutPayment({
    config: baseConfig,
    expectedOrderId: 'order_123',
    order: baseOrder,
    payment: basePayment,
    userId: 'user_123',
  });

  assert.deepEqual(result, {
    ok: true,
    subscriptionStatus: 'active',
  });
});

test('validatePremiumCheckoutPayment rejects authorized but uncaptured payments', () => {
  const result = validatePremiumCheckoutPayment({
    config: baseConfig,
    expectedOrderId: 'order_123',
    order: {
      ...baseOrder,
      status: 'attempted',
      amount_paid: 0,
      amount_due: 19900,
    },
    payment: {
      ...basePayment,
      captured: false,
      status: 'authorized',
    },
    userId: 'user_123',
  });

  assert.deepEqual(result, {
    ok: false,
    statusCode: 400,
    error: 'Payment has not been captured for this order yet.',
  });
});

test('validatePremiumCheckoutPayment rejects refunded payments even if the order is paid', () => {
  const result = validatePremiumCheckoutPayment({
    config: baseConfig,
    expectedOrderId: 'order_123',
    order: baseOrder,
    payment: {
      ...basePayment,
      amount_refunded: 19900,
      refund_status: 'full',
    },
    userId: 'user_123',
  });

  assert.deepEqual(result, {
    ok: false,
    statusCode: 400,
    error: 'Payment has already been refunded.',
  });
});

test('validatePremiumCheckoutPayment rejects orders created for a different user', () => {
  const result = validatePremiumCheckoutPayment({
    config: baseConfig,
    expectedOrderId: 'order_123',
    order: {
      ...baseOrder,
      notes: {
        ...baseOrder.notes,
        userId: 'user_other',
      },
    },
    payment: basePayment,
    userId: 'user_123',
  });

  assert.deepEqual(result, {
    ok: false,
    statusCode: 403,
    error: 'This payment belongs to a different account.',
  });
});
