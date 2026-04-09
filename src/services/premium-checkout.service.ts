import { createHmac, timingSafeEqual } from 'crypto';

export interface PremiumPlanConfig {
  amountMinor: number;
  currency: string;
  plan: string;
  billingCycle: string;
}

export type RazorpayOrderEntity = {
  id?: string;
  amount?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  status?: string;
  notes?: Record<string, unknown>;
};

export type RazorpayPaymentEntity = {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  captured?: boolean;
  currency?: string;
  order_id?: string;
  refund_status?: string | null;
  status?: string;
};

type PremiumCheckoutValidationSuccess = {
  ok: true;
  subscriptionStatus: 'active';
};

type PremiumCheckoutValidationFailure = {
  ok: false;
  error: string;
  statusCode: number;
};

export type PremiumCheckoutValidationResult =
  | PremiumCheckoutValidationSuccess
  | PremiumCheckoutValidationFailure;

type PremiumCheckoutValidationInput = {
  config: PremiumPlanConfig;
  expectedOrderId: string;
  order: RazorpayOrderEntity;
  payment: RazorpayPaymentEntity;
  userId: string;
};

export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string | undefined
): boolean {
  if (!secret) {
    return false;
  }

  const generatedSignature = createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const expected = Buffer.from(generatedSignature, 'utf8');
  const received = Buffer.from(signature, 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

function readNote(notes: Record<string, unknown> | undefined, key: string): string | null {
  const value = notes?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeText(value: string | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function currencyMatches(actual: string | undefined, expected: string) {
  return actual?.trim().toUpperCase() === expected.trim().toUpperCase();
}

export function validatePremiumCheckoutPayment(
  input: PremiumCheckoutValidationInput
): PremiumCheckoutValidationResult {
  const { config, expectedOrderId, order, payment, userId } = input;

  if (order.id !== expectedOrderId) {
    return { ok: false, statusCode: 400, error: 'Unable to validate the Razorpay order.' };
  }

  if (payment.order_id !== expectedOrderId) {
    return { ok: false, statusCode: 400, error: 'Payment is not linked to the expected order.' };
  }

  if (order.amount !== config.amountMinor || !currencyMatches(order.currency, config.currency)) {
    return { ok: false, statusCode: 400, error: 'Payment amount does not match the premium plan.' };
  }

  if (payment.amount !== config.amountMinor || !currencyMatches(payment.currency, config.currency)) {
    return { ok: false, statusCode: 400, error: 'Payment details do not match the premium plan.' };
  }

  if (normalizeText(order.status) !== 'paid') {
    return { ok: false, statusCode: 400, error: 'Payment has not been captured for this order yet.' };
  }

  if (
    typeof order.amount_paid === 'number' &&
    order.amount_paid !== config.amountMinor
  ) {
    return { ok: false, statusCode: 400, error: 'Captured payment amount is incomplete.' };
  }

  if (typeof order.amount_due === 'number' && order.amount_due !== 0) {
    return { ok: false, statusCode: 400, error: 'Payment is still pending for this order.' };
  }

  const orderUserId = readNote(order.notes, 'userId');
  if (!orderUserId) {
    return { ok: false, statusCode: 400, error: 'Payment metadata is incomplete.' };
  }

  if (orderUserId !== userId) {
    return { ok: false, statusCode: 403, error: 'This payment belongs to a different account.' };
  }

  const orderPlan = readNote(order.notes, 'plan');
  if (orderPlan !== config.plan) {
    return { ok: false, statusCode: 400, error: 'Payment plan does not match the current premium plan.' };
  }

  const orderBillingCycle = readNote(order.notes, 'billingCycle');
  if (orderBillingCycle !== config.billingCycle) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Payment billing cycle does not match the current premium plan.',
    };
  }

  const paymentStatus = normalizeText(payment.status);
  if (paymentStatus === 'refunded' || (payment.amount_refunded ?? 0) > 0) {
    return { ok: false, statusCode: 400, error: 'Payment has already been refunded.' };
  }

  if (payment.refund_status === 'partial' || payment.refund_status === 'full') {
    return { ok: false, statusCode: 400, error: 'Payment has already been refunded.' };
  }

  if (paymentStatus !== 'captured' || payment.captured === false) {
    return { ok: false, statusCode: 400, error: 'Payment is not complete yet.' };
  }

  return { ok: true, subscriptionStatus: 'active' };
}
