import jwt from 'jsonwebtoken';

const ONE_THOUSAND_DAYS_SECONDS = 60 * 60 * 24 * 1000;
const DEFAULT_ACCESS_TOKEN_SECONDS = ONE_THOUSAND_DAYS_SECONDS;
const MAX_ACCESS_TOKEN_SECONDS = ONE_THOUSAND_DAYS_SECONDS;
const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;
const WEAK_SECRET_VALUES = new Set([
  'secret',
  'password',
  'changeme',
  'change-me',
  'replace-me',
  'replace-with-at-least-32-random-bytes',
  'your-jwt-secret',
  'jwt-secret',
  'development-secret',
]);

function parseDurationSeconds(value: string | undefined, fallbackSeconds: number): number {
  if (!value) {
    return fallbackSeconds;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = value.match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    return fallbackSeconds;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === 's'
      ? 1
      : unit === 'm'
        ? 60
        : unit === 'h'
          ? 60 * 60
          : 60 * 60 * 24;

  return amount * multiplier;
}

export function getAccessTokenTtlSeconds(): number {
  const configured = process.env.AUTH_ACCESS_TOKEN_TTL || process.env.JWT_EXPIRES_IN;
  const seconds = parseDurationSeconds(configured, DEFAULT_ACCESS_TOKEN_SECONDS);
  return Math.min(MAX_ACCESS_TOKEN_SECONDS, Math.max(60, seconds));
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();

  return assertUsableAuthSecret('JWT_SECRET', secret);
}

export function isWeakAuthSecret(secret: string | undefined): boolean {
  const normalized = secret?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    WEAK_SECRET_VALUES.has(normalized) ||
    normalized.includes('replace-with') ||
    normalized.includes('your-') ||
    normalized.includes('example') ||
    /^([a-z0-9])\1+$/i.test(normalized)
  );
}

export function assertUsableAuthSecret(name: string, secret: string | undefined): string {
  const trimmedSecret = secret?.trim();

  if (!trimmedSecret) {
    throw new Error(`${name} is not defined in environment variables`);
  }

  if (
    process.env.NODE_ENV === 'production' &&
    (trimmedSecret.length < MIN_PRODUCTION_JWT_SECRET_LENGTH ||
      isWeakAuthSecret(trimmedSecret))
  ) {
    throw new Error(
      `${name} must be a strong secret with at least ${MIN_PRODUCTION_JWT_SECRET_LENGTH} characters in production`
    );
  }

  return trimmedSecret;
}

/**
 * JWT Token Payload Interface
 */
export interface JWTPayload {
  userId: string | number; // Supports both String (UUID) and Number (legacy) IDs
  sessionId?: string;
  purpose?: 'socket';
  iat?: number;
  exp?: number;
}

const DEFAULT_SOCKET_TICKET_TTL_SECONDS = 90;
const MIN_SOCKET_TICKET_TTL_SECONDS = 15;
const MAX_SOCKET_TICKET_TTL_SECONDS = 5 * 60;

export function getSocketTicketTtlSeconds(): number {
  const configured = Number(process.env.SOCKET_TICKET_TTL_SECONDS);
  const seconds = Number.isFinite(configured)
    ? Math.floor(configured)
    : DEFAULT_SOCKET_TICKET_TTL_SECONDS;

  return Math.min(MAX_SOCKET_TICKET_TTL_SECONDS, Math.max(MIN_SOCKET_TICKET_TTL_SECONDS, seconds));
}

/**
 * Generate JWT token for a user
 * 
 * @param userId - User ID to include in token payload (String or Number)
 * @returns JWT token string
 */
export function generateAccessToken(userId: string | number, sessionId?: string): string {
  const secret = getJwtSecret();
  const expiresIn = `${getAccessTokenTtlSeconds()}s`;

  const payload: JWTPayload = {
    userId,
    ...(sessionId ? { sessionId } : {}),
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn,
  } as jwt.SignOptions);
}

export function generateToken(userId: string | number): string {
  return generateAccessToken(userId);
}

/**
 * Issue a short-lived credential for a cross-origin Socket.IO handshake.
 * The browser obtains this through the authenticated same-origin API proxy,
 * so the long-lived HttpOnly access token never has to be exposed to JS.
 */
export function generateSocketTicket(userId: string | number, sessionId?: string): string {
  const payload: JWTPayload = {
    userId,
    ...(sessionId ? { sessionId } : {}),
    purpose: 'socket',
  };

  return jwt.sign(payload, getJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: `${getSocketTicketTtlSeconds()}s`,
  } as jwt.SignOptions);
}

/**
 * Verify and decode JWT token
 * 
 * @param token - JWT token string to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JWTPayload {
  const secret = getJwtSecret();

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
    }) as JWTPayload;
    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Token has expired');
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token');
    }
    throw new Error('Token verification failed');
  }
}
