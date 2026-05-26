import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { assertUsableAuthSecret } from './jwt.util';

export const ACCESS_TOKEN_COOKIE = process.env.AUTH_ACCESS_COOKIE_NAME || 'vx_access';
export const REFRESH_TOKEN_COOKIE = process.env.AUTH_REFRESH_COOKIE_NAME || 'vx_refresh';
export const CSRF_TOKEN_COOKIE = process.env.AUTH_CSRF_COOKIE_NAME || 'vx_csrf';
export const AUTH_PRESENT_COOKIE = process.env.AUTH_PRESENT_COOKIE_NAME || 'vx_auth_present';

type SameSite = boolean | 'lax' | 'strict' | 'none';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function getCookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE === 'true') return true;
  if (process.env.AUTH_COOKIE_SECURE === 'false') return false;
  return isProduction();
}

function getSameSite(): SameSite {
  const value = (process.env.AUTH_COOKIE_SAME_SITE || '').toLowerCase();
  if (value === 'none' || value === 'strict' || value === 'lax') {
    return value;
  }
  return 'lax';
}

function getCookieDomain(): string | undefined {
  return process.env.AUTH_COOKIE_DOMAIN || undefined;
}

function cookieBaseOptions() {
  const secure = getCookieSecure();
  const sameSite = getSameSite();

  if (sameSite === 'none' && !secure) {
    throw new Error('AUTH_COOKIE_SAME_SITE=none requires secure auth cookies');
  }

  return {
    secure,
    sameSite,
    path: '/',
    ...(getCookieDomain() ? { domain: getCookieDomain() } : {}),
  };
}

function getCsrfSecret(): string {
  const secret = process.env.AUTH_CSRF_SECRET || process.env.JWT_SECRET;
  return assertUsableAuthSecret('AUTH_CSRF_SECRET or JWT_SECRET', secret);
}

export function createCsrfToken(sessionId: string): string {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getCsrfSecret())
    .update(`${sessionId}.${nonce}`)
    .digest('base64url');
  return `${nonce}.${signature}`;
}

export function verifyCsrfToken(token: string | undefined, sessionId: string | undefined): boolean {
  if (!token || !sessionId) {
    return false;
  }

  const [nonce, signature] = token.split('.');
  if (!nonce || !signature) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', getCsrfSecret())
    .update(`${sessionId}.${nonce}`)
    .digest('base64url');

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  return (
    expectedBuffer.length === signatureBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  );
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  return header.split(';').reduce<Record<string, string>>((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) {
      return cookies;
    }

    try {
      cookies[rawName] = decodeURIComponent(rawValue.join('='));
    } catch {
      cookies[rawName] = rawValue.join('=');
    }
    return cookies;
  }, {});
}

export function parseCookies(req: Request): Record<string, string> {
  return parseCookieHeader(req.headers.cookie);
}

export function getCookie(req: Request, name: string): string | undefined {
  return parseCookies(req)[name];
}

export function getCsrfTokenFromRequest(req: Request): string | undefined {
  const headerToken = req.headers['x-csrf-token'];
  if (Array.isArray(headerToken)) {
    return headerToken[0];
  }
  return typeof headerToken === 'string' ? headerToken : undefined;
}

export function isUnsafeHttpMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function setAuthCookies(
  res: Response,
  params: {
    accessToken: string;
    accessMaxAgeSeconds: number;
    refreshToken: string;
    refreshExpiresAt: Date;
    sessionId: string;
  }
): string {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  const refreshMaxAgeMs = Math.max(0, params.refreshExpiresAt.getTime() - Date.now());
  const csrfToken = createCsrfToken(params.sessionId);

  res.cookie(ACCESS_TOKEN_COOKIE, params.accessToken, {
    ...cookieBaseOptions(),
    httpOnly: true,
    maxAge: params.accessMaxAgeSeconds * 1000,
  });

  res.cookie(REFRESH_TOKEN_COOKIE, params.refreshToken, {
    ...cookieBaseOptions(),
    httpOnly: true,
    maxAge: refreshMaxAgeMs,
  });

  res.cookie(CSRF_TOKEN_COOKIE, csrfToken, {
    ...cookieBaseOptions(),
    httpOnly: false,
    maxAge: refreshMaxAgeMs,
  });

  res.cookie(AUTH_PRESENT_COOKIE, 'true', {
    ...cookieBaseOptions(),
    httpOnly: false,
    maxAge: refreshMaxAgeMs,
  });

  return csrfToken;
}

export function clearAuthCookies(res: Response): void {
  const options = cookieBaseOptions();
  for (const cookieName of [
    ACCESS_TOKEN_COOKIE,
    REFRESH_TOKEN_COOKIE,
    CSRF_TOKEN_COOKIE,
    AUTH_PRESENT_COOKIE,
    'authToken',
    'admin_token',
  ]) {
    res.clearCookie(cookieName, options);
  }
}
