import type { Request, Response } from 'express';
import { createAuthSession } from './auth-session.service';
import { generateAccessToken, getAccessTokenTtlSeconds } from '../utils/jwt.util';
import { setAuthCookies } from '../utils/auth-cookie.util';

export interface IssuedAuthTransport {
  token: string;
  refreshToken: string;
  csrfToken: string;
  session: {
    id: string;
    expiresAt: string;
  };
}

export function shouldReturnAuthTokensInBody(req: Request): boolean {
  const requestedTransport = String(req.headers['x-auth-token-transport'] || '').toLowerCase();
  const browserRequest = Boolean(req.headers.origin || req.headers['sec-fetch-site']);

  if (browserRequest) {
    return false;
  }

  return requestedTransport === 'bearer';
}

export async function issueAuthTransport(
  req: Request,
  res: Response,
  userId: string | number
): Promise<IssuedAuthTransport> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  const session = await createAuthSession({
    userId: String(userId),
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });
  const token = generateAccessToken(userId, session.sessionId);

  const csrfToken = setAuthCookies(res, {
    accessToken: token,
    accessMaxAgeSeconds: getAccessTokenTtlSeconds(),
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.expiresAt,
    sessionId: session.sessionId,
  });

  return {
    token,
    refreshToken: session.refreshToken,
    csrfToken,
    session: {
      id: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

export function authTokensForResponse(
  req: Request,
  transport: IssuedAuthTransport
): Partial<IssuedAuthTransport> {
  if (!shouldReturnAuthTokensInBody(req)) {
    return {
      csrfToken: transport.csrfToken,
      session: transport.session,
    };
  }

  return transport;
}
