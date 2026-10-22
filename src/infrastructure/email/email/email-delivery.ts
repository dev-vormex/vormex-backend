import { fetchWithBreaker } from "../../http/http-client-with-breaker.util";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EmailServiceConfigurationError, ResendHeaders, emailServiceCheckCache, EMAIL_SERVICE_CHECK_TTL_MS, EmailServiceCheckCache, EmailServiceUnavailableError, RESEND_DOMAINS_ENDPOINT, updateEmailServiceCheckCache, EmailSendError, EmailDeliveryError, PublicEmailDeliveryFailure, EmailAttachment } from "./email-errors";

export function getEmailConfig(): {
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

export async function ensureEmailServiceReady(): Promise<void> {
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
    const response = await fetchWithBreaker('resend', 'list_domains', RESEND_DOMAINS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
      },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 8_000 });

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

export function toPublicEmailDeliveryFailure(error: unknown): PublicEmailDeliveryFailure {
  const retryAfterSeconds =
    error instanceof EmailServiceUnavailableError ? error.retryAfterSeconds : undefined;

  return {
    statusCode: error instanceof EmailDeliveryError ? 502 : 503,
    body: {
      error: 'Email delivery is temporarily unavailable. Please try again.',
      code: 'email_delivery_unavailable',
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
  };
}

export function normalizeResendSendError(
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveVormexLogo(): {
  src: string;
  attachments?: EmailAttachment[];
} {
  const contentId = 'vormex-logo';
  const configuredLogoPath = process.env.EMAIL_LOGO_PATH?.trim();
  const localLogoCandidates = [
    configuredLogoPath,
    path.resolve(process.cwd(), '../vormex-web/public/logo.png'),
    path.resolve(process.cwd(), '../admin/public/vormex-logo.png'),
    path.resolve(process.cwd(), 'public/logo.png'),
  ].filter((value): value is string => Boolean(value));

  const localLogoPath = localLogoCandidates.find((candidate) => existsSync(candidate));
  if (localLogoPath) {
    return {
      src: `cid:${contentId}`,
      attachments: [
        {
          content: readFileSync(localLogoPath),
          filename: 'vormex-logo.png',
          contentType: 'image/png',
          contentId,
        },
      ],
    };
  }

  const configuredLogoUrl = process.env.EMAIL_LOGO_URL?.trim();
  const frontendUrl = process.env.FRONTEND_URL?.trim();
  const frontendLogoUrl =
    frontendUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(frontendUrl)
      ? `${frontendUrl.replace(/\/+$/, '')}/logo.png`
      : null;

  return {
    src: configuredLogoUrl || frontendLogoUrl || 'https://vormex.in/logo.png',
  };
}
