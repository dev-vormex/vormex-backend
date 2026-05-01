import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

const RESEND_DOMAINS_ENDPOINT = 'https://api.resend.com/domains';
const EMAIL_SERVICE_CHECK_TTL_MS = 5 * 60 * 1000;

type EmailServiceCheckCache = {
  cacheKey: string;
  checkedAt: number;
  ok: boolean;
  errorMessage?: string;
  errorCode?: string;
  retryAfterSeconds?: number;
};

type ResendHeaders = Record<string, string | number | undefined> | null | undefined;

let emailServiceCheckCache: EmailServiceCheckCache | null = null;

function getResendResponseHeaders(response: unknown): ResendHeaders {
  const headers = (response as { headers?: ResendHeaders } | null | undefined)?.headers;
  return headers ?? null;
}

class EmailSendError extends Error {
  code: string;
  statusCode: number;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      retryAfterSeconds?: number;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class EmailServiceConfigurationError extends EmailSendError {
  constructor(message: string, code = 'EMAIL_SERVICE_CONFIGURATION_ERROR') {
    super(message, {
      code,
      statusCode: 503,
    });
  }
}

export class EmailServiceUnavailableError extends EmailSendError {
  constructor(
    message: string,
    code = 'EMAIL_SERVICE_UNAVAILABLE',
    retryAfterSeconds?: number
  ) {
    super(message, {
      code,
      statusCode: 503,
      retryAfterSeconds,
    });
  }
}

export class EmailDeliveryError extends EmailSendError {
  constructor(message: string, statusCode = 502) {
    super(message, {
      code: 'EMAIL_DELIVERY_FAILED',
      statusCode,
    });
  }
}

export function isEmailServiceUnavailableError(
  error: unknown
): error is EmailServiceConfigurationError | EmailServiceUnavailableError {
  return (
    error instanceof EmailServiceConfigurationError ||
    error instanceof EmailServiceUnavailableError
  );
}

function getEmailConfig(): {
  emailFrom: string;
  frontendUrl: string;
  resendApiKey: string;
  senderDomain: string;
} {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (!resendApiKey) {
    throw new EmailServiceConfigurationError(
      'Email service is not configured. Set RESEND_API_KEY before sending emails.',
      'RESEND_API_KEY_MISSING'
    );
  }

  const emailFrom = process.env.EMAIL_FROM?.trim();
  if (!emailFrom) {
    throw new EmailServiceConfigurationError(
      'Email service is not configured. Set EMAIL_FROM to an address on a verified Resend domain.',
      'EMAIL_FROM_MISSING'
    );
  }

  const frontendUrl = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';

  return {
    emailFrom,
    frontendUrl,
    resendApiKey,
    senderDomain: extractSenderDomain(emailFrom),
  };
}

function extractSenderDomain(emailFrom: string): string {
  const emailAddressMatch = emailFrom.match(/<([^>]+)>/);
  const emailAddress = (emailAddressMatch?.[1] ?? emailFrom).trim();
  const atIndex = emailAddress.lastIndexOf('@');

  if (atIndex === -1 || atIndex === emailAddress.length - 1) {
    throw new EmailServiceConfigurationError(
      'EMAIL_FROM must be a valid email address or display-name email address.',
      'EMAIL_FROM_INVALID'
    );
  }

  return emailAddress.slice(atIndex + 1).toLowerCase();
}

function getEmailServiceCacheKey(resendApiKey: string, emailFrom: string): string {
  return `${resendApiKey.slice(0, 8)}:${emailFrom.toLowerCase()}`;
}

function getRetryAfterSeconds(headers: ResendHeaders): number | undefined {
  const value = headers?.ratelimitReset ?? headers?.['ratelimit-reset'];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function parseJsonSafely(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function updateEmailServiceCheckCache(cache: EmailServiceCheckCache): void {
  emailServiceCheckCache = cache;
}

function getCachedEmailServiceCheck(cacheKey: string): EmailServiceCheckCache | null {
  if (!emailServiceCheckCache) {
    return null;
  }

  const isFresh = Date.now() - emailServiceCheckCache.checkedAt < EMAIL_SERVICE_CHECK_TTL_MS;
  if (!isFresh || emailServiceCheckCache.cacheKey !== cacheKey) {
    return null;
  }

  return emailServiceCheckCache;
}

function buildCachedEmailServiceError(
  cache: EmailServiceCheckCache
): EmailServiceConfigurationError | EmailServiceUnavailableError {
  const message = cache.errorMessage || 'Email service is temporarily unavailable.';
  const unavailableCodes = new Set([
    'EMAIL_SERVICE_UNAVAILABLE',
    'EMAIL_SERVICE_NETWORK_ERROR',
    'EMAIL_SERVICE_RATE_LIMITED',
    'EMAIL_PROVIDER_UNAVAILABLE',
  ]);

  if (cache.errorCode && unavailableCodes.has(cache.errorCode)) {
    return new EmailServiceUnavailableError(
      message,
      cache.errorCode || 'EMAIL_SERVICE_UNAVAILABLE',
      cache.retryAfterSeconds
    );
  }

  return new EmailServiceConfigurationError(
    message,
    cache.errorCode || 'EMAIL_SERVICE_CONFIGURATION_ERROR'
  );
}

async function assertEmailServiceReady(): Promise<void> {
  const { resendApiKey, emailFrom, senderDomain } = getEmailConfig();
  const cacheKey = getEmailServiceCacheKey(resendApiKey, emailFrom);
  const cachedResult = getCachedEmailServiceCheck(cacheKey);

  if (cachedResult) {
    if (!cachedResult.ok) {
      throw buildCachedEmailServiceError(cachedResult);
    }
    return;
  }

  try {
    const response = await fetch(RESEND_DOMAINS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
      },
    });

    if (!response.ok) {
      const responseBody = await parseJsonSafely(response);
      const retryAfterSeconds = getRetryAfterSeconds(
        Object.fromEntries(response.headers.entries())
      );
      const providerErrorName = String(responseBody?.name || '').toLowerCase();
      const providerMessage =
        responseBody?.message || responseBody?.error || 'Failed to query Resend domains.';

      if (
        response.status === 401 &&
        providerErrorName === 'restricted_api_key' &&
        String(providerMessage).toLowerCase().includes('restricted to only send emails')
      ) {
        // Send-only API keys cannot inspect domains. Let the actual send attempt classify the error.
        updateEmailServiceCheckCache({
          cacheKey,
          checkedAt: Date.now(),
          ok: true,
        });
        return;
      }

      if (response.status === 401 || response.status === 403) {
        const error = new EmailServiceConfigurationError(
          'Email service is not configured correctly. Please check the Resend API key and sender domain access.',
          'RESEND_API_KEY_INVALID'
        );
        updateEmailServiceCheckCache({
          cacheKey,
          checkedAt: Date.now(),
          ok: false,
          errorMessage: error.message,
          errorCode: error.code,
        });
        throw error;
      }

      const error = new EmailServiceUnavailableError(
        `Email service is temporarily unavailable. ${providerMessage}`,
        'EMAIL_SERVICE_UNAVAILABLE',
        retryAfterSeconds
      );
      updateEmailServiceCheckCache({
        cacheKey,
        checkedAt: Date.now(),
        ok: false,
        errorMessage: error.message,
        errorCode: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      throw error;
    }

    const body = await parseJsonSafely(response);
    const domains = Array.isArray(body?.data) ? body.data : [];
    const matchingDomain = domains.find(
      (domain: { name?: string } | null | undefined) =>
        typeof domain?.name === 'string' && domain.name.toLowerCase() === senderDomain
    );

    if (!matchingDomain) {
      const error = new EmailServiceConfigurationError(
        `Email service is not ready. Add and verify the ${senderDomain} domain in Resend, or update EMAIL_FROM to use a verified sender.`,
        'EMAIL_SENDER_DOMAIN_MISSING'
      );
      updateEmailServiceCheckCache({
        cacheKey,
        checkedAt: Date.now(),
        ok: false,
        errorMessage: error.message,
        errorCode: error.code,
      });
      throw error;
    }

    updateEmailServiceCheckCache({
      cacheKey,
      checkedAt: Date.now(),
      ok: true,
    });
  } catch (error) {
    if (error instanceof EmailSendError) {
      throw error;
    }

    const unavailableError = new EmailServiceUnavailableError(
      'Email service is temporarily unavailable. Unable to reach Resend.',
      'EMAIL_SERVICE_NETWORK_ERROR'
    );
    updateEmailServiceCheckCache({
      cacheKey,
      checkedAt: Date.now(),
      ok: false,
      errorMessage: unavailableError.message,
      errorCode: unavailableError.code,
      retryAfterSeconds: unavailableError.retryAfterSeconds,
    });
    throw unavailableError;
  }
}

function normalizeResendSendError(
  error: { statusCode?: number; message?: string; name?: string },
  headers: ResendHeaders
): EmailSendError {
  const statusCode = error.statusCode ?? 502;
  const message = error.message || 'Unknown Resend error';
  const lowerMessage = message.toLowerCase();
  const retryAfterSeconds = getRetryAfterSeconds(headers);

  if (
    statusCode === 403 &&
    (
      lowerMessage.includes('domain is not verified') ||
      lowerMessage.includes('add and verify your domain') ||
      lowerMessage.includes('verified domain') ||
      lowerMessage.includes('testing emails to your own email address')
    )
  ) {
    return new EmailServiceConfigurationError(
      'Email service is not ready. The configured sender domain is not verified in Resend.',
      'EMAIL_SENDER_DOMAIN_NOT_VERIFIED'
    );
  }

  if (statusCode === 401) {
    return new EmailServiceConfigurationError(
      'Email service is not configured correctly. Resend rejected the configured API key.',
      'RESEND_API_KEY_INVALID'
    );
  }

  if (statusCode === 429) {
    return new EmailServiceUnavailableError(
      'Email service is temporarily rate-limited. Please try again shortly.',
      'EMAIL_SERVICE_RATE_LIMITED',
      retryAfterSeconds
    );
  }

  if (statusCode >= 500) {
    return new EmailServiceUnavailableError(
      'Email service is temporarily unavailable. Please try again later.',
      'EMAIL_PROVIDER_UNAVAILABLE',
      retryAfterSeconds
    );
  }

  return new EmailDeliveryError(`Failed to send email: ${message}`, statusCode);
}

async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const { emailFrom } = getEmailConfig();
  await assertEmailServiceReady();

  try {
    const result = await resend.emails.send({
      from: emailFrom,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });

    if (result.error) {
      throw normalizeResendSendError(result.error, getResendResponseHeaders(result));
    }

    if (!result.data) {
      throw new EmailDeliveryError('Email sending failed: No data returned from Resend');
    }
  } catch (error) {
    if (error instanceof EmailSendError) {
      throw error;
    }

    throw new EmailServiceUnavailableError(
      'Email service is temporarily unavailable. Unable to send email through Resend.',
      'EMAIL_SERVICE_NETWORK_ERROR'
    );
  }
}

/**
 * Send password reset email to user
 *
 * @param email - User's email address
 * @param resetToken - Plain text reset token (will be included in URL)
 * @throws Error if email sending fails
 */
export async function sendPasswordResetEmail(
  email: string,
  resetToken: string
): Promise<void> {
  const { frontendUrl } = getEmailConfig();
  const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px 30px;">
              <h1 style="margin: 0 0 20px 0; color: #000000; font-size: 24px; font-weight: 600;">Reset Your Password</h1>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Hello,
              </p>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                We received a request to reset your password for your Vormex account. If you made this request, click the button below to reset your password.
              </p>

              <table role="presentation" style="width: 100%; margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center;">Reset Password</a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                Or copy and paste this link into your browser:
              </p>

              <p style="margin: 0 0 20px 0; color: #2563eb; font-size: 14px; word-break: break-all; line-height: 1.5;">
                ${resetUrl}
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                <strong>This link will expire in 1 hour.</strong> If you don't reset your password within this time, you'll need to request a new reset link.
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                If you didn't request a password reset, please ignore this email. Your password will remain unchanged.
              </p>

              <p style="margin: 30px 0 0 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Best regards,<br>
                <strong>The Vormex Team</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textBody = `
Reset Your Password

Hello,

We received a request to reset your password for your Vormex account. If you made this request, use the link below to reset your password:

${resetUrl}

This link will expire in 1 hour. If you don't reset your password within this time, you'll need to request a new reset link.

If you didn't request a password reset, please ignore this email. Your password will remain unchanged.

Best regards,
The Vormex Team
  `.trim();

  await sendEmail({
    to: email,
    subject: 'Reset Your Vormex Password',
    html: htmlBody,
    text: textBody,
  });

  console.log('Password reset email sent successfully to:', email);
}

/**
 * Send email verification email to user
 *
 * @param email - User's email address
 * @param verificationToken - Plain text verification token (will be included in URL)
 * @param name - User's name for personalization
 * @throws Error if email sending fails
 */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string,
  name: string
): Promise<void> {
  const { frontendUrl } = getEmailConfig();
  const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Account</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 40px 30px;">
              <h1 style="margin: 0 0 20px 0; color: #000000; font-size: 24px; font-weight: 600;">Welcome to Vormex!</h1>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Hello ${name},
              </p>

              <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Thank you for joining Vormex! We're excited to have you on board. To get started and access all features, please verify your email address by clicking the button below.
              </p>

              <table role="presentation" style="width: 100%; margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${verificationUrl}" style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; text-align: center;">Verify Email Address</a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                Or copy and paste this link into your browser:
              </p>

              <p style="margin: 0 0 20px 0; color: #2563eb; font-size: 14px; word-break: break-all; line-height: 1.5;">
                ${verificationUrl}
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                <strong>This verification link will expire in 24 hours.</strong> If you don't verify your email within this time, you can request a new verification email.
              </p>

              <p style="margin: 0 0 20px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                If you didn't create a Vormex account, please ignore this email.
              </p>

              <p style="margin: 30px 0 0 0; color: #333333; font-size: 16px; line-height: 1.5;">
                Best regards,<br>
                <strong>The Vormex Team</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  const textBody = `
Welcome to Vormex!

Hello ${name},

Thank you for joining Vormex! We're excited to have you on board. To get started and access all features, please verify your email address using the link below:

${verificationUrl}

This verification link will expire in 24 hours. If you don't verify your email within this time, you can request a new verification email.

If you didn't create a Vormex account, please ignore this email.

Best regards,
The Vormex Team
  `.trim();

  await sendEmail({
    to: email,
    subject: 'Verify Your Vormex Account',
    html: htmlBody,
    text: textBody,
  });

  console.log('Verification email sent successfully to:', email);
}
