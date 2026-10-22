import { Response } from "express";
import { getRazorpayWebhookSecret, isRazorpayConfigured, verifyRazorpayWebhookSignature, fetchRazorpayOrder, fetchRazorpayPayment, readOrderUserId, activatePremiumFromRazorpayPayment } from "../../services/premium-razorpay.service";
import { prisma } from "../../../../config/prisma";
import { logPremiumCheckoutEvent } from "../../services/premium-access.service";
import { WebhookRequest, RazorpayWebhookPayload } from "./support.controller";
import { getSafeRazorpayError } from "./checkout-support.controller";

/**
 * Razorpay webhook receiver. The browser verify call is best-effort — a user can pay and
 * then close the tab before it runs — so this is the authoritative path that still grants
 * premium for a captured payment. Configure the endpoint plus RAZORPAY_WEBHOOK_SECRET in
 * the Razorpay dashboard for `payment.captured` and `order.paid`.
 */
export const handleRazorpayWebhook = async (
  req: WebhookRequest,
  res: Response
): Promise<void> => {
  const webhookSecret = getRazorpayWebhookSecret();

  if (!webhookSecret || !isRazorpayConfigured()) {
    res.status(503).json({ error: 'Razorpay webhooks are not configured on this server.' });
    return;
  }

  const signature = req.header('x-razorpay-signature') || undefined;
  const rawBody = req.rawBody;

  if (!rawBody) {
    res.status(400).json({ error: 'Webhook body could not be read.' });
    return;
  }

  if (!verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn('Rejected a Razorpay webhook with an invalid signature.');
    res.status(400).json({ error: 'Invalid webhook signature.' });
    return;
  }

  // Read from the verified raw body rather than the parsed/sanitised copy: only the raw
  // bytes are covered by the signature we just checked.
  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookPayload;
  } catch {
    res.status(400).json({ error: 'Webhook body is not valid JSON.' });
    return;
  }

  const event = String(payload.event || '');
  const paymentEntity = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity;
  const paymentId = String(paymentEntity?.id || '').trim();
  const orderId = String(paymentEntity?.order_id || orderEntity?.id || '').trim();

  // Acknowledge everything else so Razorpay stops retrying events we do not act on.
  if (!['payment.captured', 'order.paid'].includes(event) || !paymentId || !orderId) {
    res.status(200).json({ received: true, handled: false });
    return;
  }

  try {
    const [order, payment] = await Promise.all([
      fetchRazorpayOrder(orderId),
      fetchRazorpayPayment(paymentId),
    ]);

    const userId = readOrderUserId(order);
    if (!userId) {
      console.warn(`Razorpay webhook order ${orderId} has no userId note; skipping.`);
      res.status(200).json({ received: true, handled: false });
      return;
    }

    // A deleted account can never be activated, so answer 200 instead of letting the
    // downstream "user not found" throw turn into an endless Razorpay retry loop.
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!userExists) {
      console.warn(`Razorpay webhook order ${orderId} references a missing user; skipping.`);
      res.status(200).json({ received: true, handled: false });
      return;
    }

    const activation = await activatePremiumFromRazorpayPayment({
      userId,
      orderId,
      paymentId,
      order,
      payment,
      source: 'webhook',
    });

    if (activation.ok === false) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_WEBHOOK',
        outcome: 'failure',
        message: `Razorpay webhook could not unlock premium: ${activation.error}`,
        metadata: { event, orderId, paymentId },
      });
      // 200 keeps Razorpay from retrying a payload we have permanently rejected.
      res.status(200).json({ received: true, handled: false });
      return;
    }

    res.status(200).json({
      received: true,
      handled: true,
      alreadyActivated: activation.alreadyActivated,
    });
  } catch (error) {
    const safeError = getSafeRazorpayError(error);
    console.error('Failed to process Razorpay webhook', safeError.logMessage, safeError.metadata);
    // 5xx asks Razorpay to retry, which is what we want for transient upstream failures.
    res.status(502).json({ error: 'Could not process the webhook right now.' });
  }
};
