import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EmailDeliveryError,
  EmailServiceConfigurationError,
  ensureEmailServiceReady,
  toPublicEmailDeliveryFailure,
} from '../utils/email.util';

test('missing email configuration fails before a request can claim an email was sent', async () => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousEmailFrom = process.env.EMAIL_FROM;

  delete process.env.RESEND_API_KEY;
  process.env.EMAIL_FROM = 'noreply@example.com';

  try {
    await assert.rejects(ensureEmailServiceReady, EmailServiceConfigurationError);
  } finally {
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;

    if (previousEmailFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousEmailFrom;
  }
});

test('email delivery errors are converted to a safe actionable API failure', () => {
  const failure = toPublicEmailDeliveryFailure(
    new EmailDeliveryError('provider-specific message', 400)
  );

  assert.deepEqual(failure, {
    statusCode: 502,
    body: {
      error: 'Email delivery is temporarily unavailable. Please try again.',
      code: 'email_delivery_unavailable',
    },
  });
});
