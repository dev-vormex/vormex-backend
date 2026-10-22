import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

export const RESEND_DOMAINS_ENDPOINT = 'https://api.resend.com/domains';

export const EMAIL_SERVICE_CHECK_TTL_MS = 5 * 60 * 1000;

export type EmailServiceCheckCache = {
  cacheKey: string;
  checkedAt: number;
  ok: boolean;
  errorMessage?: string;
  errorCode?: string;
  retryAfterSeconds?: number;
};

export type ResendHeaders = Record<string, string | number | undefined> | null | undefined;

export type EmailAttachment = {
  content: Buffer;
  filename: string;
  contentType: string;
  contentId: string;
};

export type PublicEmailDeliveryFailure = {
  statusCode: number;
  body: {
    error: string;
    code: string;
    retryAfterSeconds?: number;
  };
};

export let emailServiceCheckCache: EmailServiceCheckCache | null = null;

export function getResendResponseHeaders(response: unknown): ResendHeaders {
  const headers = (response as { headers?: ResendHeaders } | null | undefined)?.headers;
  return headers ?? null;
}

export class EmailSendError extends Error {
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

export function updateEmailServiceCheckCache(cache: EmailServiceCheckCache): void {
  emailServiceCheckCache = cache;
}
