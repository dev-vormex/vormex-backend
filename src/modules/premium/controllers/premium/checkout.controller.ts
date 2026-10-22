import { Response } from "express";
import { logPremiumCheckoutEvent, getPremiumAccessSnapshot, normalizePremiumCheckoutPlan, isCreatorProPlan, serializePremiumSubscription, normalizePremiumBillingCycle, buildPremiumPlanConfig, getPremiumDurationDaysForBillingCycle, formatCurrency } from "../../services/premium-access.service";
import { isRazorpayConfigured, createRazorpayOrder, fetchRazorpayOrder, fetchRazorpayPayment, activatePremiumFromRazorpayPayment } from "../../services/premium-razorpay.service";
import { prisma } from "../../../../config/prisma";
import { verifyRazorpaySignature } from "../../services/premium-checkout.service";
import { AuthRequest, isPremiumCheckoutConfigured } from "./support.controller";
import { getSafeRazorpayError } from "./checkout-support.controller";

export const createPremiumCheckout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'CLICKED_GET_PREMIUM',
      outcome: 'info',
      message: 'User clicked the Get Premium button.',
    });

    if (!isRazorpayConfigured()) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: 'Premium checkout is not configured on the server yet.',
      });
      res.status(503).json({ error: 'Premium checkout is not configured on the server yet.' });
      return;
    }

    const [snapshot, user] = await Promise.all([
      getPremiumAccessSnapshot(userId),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
        },
      }),
    ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const requestedPlan = normalizePremiumCheckoutPlan(req.body?.plan);
    const isCreatorProCheckout = isCreatorProPlan(requestedPlan);

    if (snapshot.isPremium && (!isCreatorProCheckout || snapshot.isCreatorPro)) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: isCreatorProCheckout
          ? 'Creator Pro is already active for this account.'
          : 'Premium is already active for this account.',
        amountMinor: snapshot.premiumAmountMinor,
        currency: snapshot.premiumCurrency,
      });
      res.status(409).json({
        error: isCreatorProCheckout
          ? 'Creator Pro is already active for this account.'
          : 'Premium is already active for this account.',
        subscription: serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
      });
      return;
    }

    const requestedBillingCycle = normalizePremiumBillingCycle(req.body?.billingCycle);
    const config = buildPremiumPlanConfig(snapshot, requestedBillingCycle, requestedPlan);
    const durationDays = getPremiumDurationDaysForBillingCycle(config.billingCycle);
    const receiptPrefix = isCreatorProCheckout ? 'creator' : 'premium';
    const receipt = `${receiptPrefix}_${userId.slice(0, 8)}_${Date.now().toString(36)}`.slice(0, 40);
    const notes = {
      userId,
      plan: config.plan,
      billingCycle: config.billingCycle,
      amountMinor: String(config.amountMinor),
      currency: config.currency,
      durationDays: String(durationDays),
    };

    const order = await createRazorpayOrder({
      amount: config.amountMinor,
      currency: config.currency,
      receipt,
      notes,
    });

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'CHECKOUT_CREATED',
      outcome: 'success',
      message: 'Premium checkout order created successfully.',
      amountMinor: config.amountMinor,
      currency: config.currency,
      metadata: {
        provider: 'razorpay',
        orderId: order.id,
        receipt,
        plan: config.plan,
        billingCycle: config.billingCycle,
      },
    });

    res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amountMinor: config.amountMinor,
      currency: config.currency,
      displayAmount: formatCurrency(config.amountMinor, config.currency),
      plan: config.plan,
      title: config.title,
      description: config.description,
      billingCycle: config.billingCycle,
      premiumDurationDays: durationDays,
      prefill: {
        name: user.name,
        email: user.email,
      },
      features: config.features,
    });
  } catch (error) {
    const safeError = getSafeRazorpayError(error);
    console.error('Failed to create premium checkout', safeError.logMessage, safeError.metadata);
    if (req.user?.userId) {
      await logPremiumCheckoutEvent({
        userId: req.user.userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: safeError.logMessage,
        metadata: safeError.metadata,
      });
    }
    res.status(safeError.statusCode).json({
      error: safeError.clientMessage,
      code: safeError.code,
    });
  }
};

export const verifyPremiumCheckout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const body = req.body as {
      razorpayOrderId?: string;
      razorpayPaymentId?: string;
      razorpaySignature?: string;
    };

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const razorpayOrderId = body.razorpayOrderId?.trim();
    const razorpayPaymentId = body.razorpayPaymentId?.trim();
    const razorpaySignature = body.razorpaySignature?.trim();

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: 'Missing payment verification details.',
      });
      res.status(400).json({ error: 'Missing payment verification details.' });
      return;
    }

    if (!isRazorpayConfigured()) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: 'Premium checkout is not configured on the server yet.',
      });
      res.status(503).json({ error: 'Premium checkout is not configured on the server yet.' });
      return;
    }

    if (
      !verifyRazorpaySignature(
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        process.env.RAZORPAY_KEY_SECRET
      )
    ) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: 'Payment signature verification failed.',
      });
      res.status(400).json({ error: 'Payment signature verification failed.' });
      return;
    }

    const [order, payment] = await Promise.all([
      fetchRazorpayOrder(razorpayOrderId),
      fetchRazorpayPayment(razorpayPaymentId),
    ]);

    const activation = await activatePremiumFromRazorpayPayment({
      userId,
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      order,
      payment,
      source: 'checkout',
    });

    if (activation.ok === false) {
      res.status(activation.statusCode).json({ error: activation.error });
      return;
    }

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);

    res.json({
      message: activation.alreadyActivated
        ? 'This payment was already applied to your account.'
        : 'Premium unlocked successfully.',
      alreadyActivated: activation.alreadyActivated,
      subscription: serializePremiumSubscription(updatedSnapshot, isPremiumCheckoutConfigured()),
    });
  } catch (error) {
    const safeError = getSafeRazorpayError(error);
    console.error('Failed to verify premium checkout', safeError.logMessage, safeError.metadata);
    if (req.user?.userId) {
      await logPremiumCheckoutEvent({
        userId: req.user.userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message:
          safeError.code === 'premium_checkout_failed'
            ? 'Failed to verify premium checkout'
            : safeError.logMessage,
        metadata: safeError.metadata,
      });
    }
    res.status(safeError.statusCode).json({
      error:
        safeError.code === 'premium_checkout_failed'
          ? 'Failed to verify premium checkout'
          : safeError.clientMessage,
      code:
        safeError.code === 'premium_checkout_failed'
          ? 'premium_verification_failed'
          : safeError.code,
    });
  }
};
