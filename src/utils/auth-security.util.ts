import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const DEFAULT_PASSWORD_MIN_LENGTH = 12;
const DEFAULT_PASSWORD_MAX_LENGTH = 128;
const DEFAULT_BCRYPT_ROUNDS = 12;
const MIN_BCRYPT_ROUNDS = 10;
const MAX_BCRYPT_ROUNDS = 14;

const DUMMY_PASSWORD_HASH =
  '$2a$12$MIXrVGH.t/zvwOmhTCzyz.EMEyaV6xUjo8ULpCRkDEvR4qiK/eGDq';

function getNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function getPasswordMinLength(): number {
  return Math.max(8, getNumberEnv('AUTH_PASSWORD_MIN_LENGTH', DEFAULT_PASSWORD_MIN_LENGTH));
}

export function getPasswordMaxLength(): number {
  return Math.max(
    getPasswordMinLength(),
    getNumberEnv('AUTH_PASSWORD_MAX_LENGTH', DEFAULT_PASSWORD_MAX_LENGTH)
  );
}

function getBcryptRounds(): number {
  const configured = getNumberEnv('AUTH_PASSWORD_BCRYPT_ROUNDS', DEFAULT_BCRYPT_ROUNDS);
  return Math.min(MAX_BCRYPT_ROUNDS, Math.max(MIN_BCRYPT_ROUNDS, configured));
}

function normalizeForPasswordComparison(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function validatePasswordStrength(
  password: string,
  userInputs: Array<string | null | undefined> = []
): string | null {
  if (typeof password !== 'string') {
    return 'Password is required';
  }

  const minLength = getPasswordMinLength();
  const maxLength = getPasswordMaxLength();

  if (password.length < minLength) {
    return `Password must be at least ${minLength} characters long`;
  }

  if (password.length > maxLength) {
    return `Password must be no more than ${maxLength} characters long`;
  }

  const characterClassCount = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;

  if (characterClassCount < 3) {
    return 'Password must include at least three of uppercase, lowercase, number, and symbol characters';
  }

  const normalizedPassword = password.toLowerCase();
  for (const input of userInputs) {
    const normalizedInput = normalizeForPasswordComparison(input);
    if (normalizedInput.length >= 4 && normalizedPassword.includes(normalizedInput)) {
      return 'Password must not contain your name, email, or username';
    }
  }

  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, getBcryptRounds());
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function passwordHashNeedsRehash(passwordHash: string | null | undefined): boolean {
  if (!passwordHash) {
    return false;
  }

  const match = passwordHash.match(/^\$2[aby]\$(\d{2})\$/);
  if (!match) {
    return true;
  }

  return Number(match[1]) < getBcryptRounds();
}

export async function compareWithDummyPassword(password: string): Promise<void> {
  await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  const digest = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function getOtpSecret(): string {
  const secret = process.env.AUTH_OTP_PEPPER?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('AUTH_OTP_PEPPER or JWT_SECRET is required for email OTP verification');
  }
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('AUTH_OTP_PEPPER must be at least 32 characters in production');
  }
  return secret;
}

export function generateEmailOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function normalizeEmailOtpCode(code: string | null | undefined): string {
  return String(code || '').replace(/\s+/g, '').trim();
}

export function hashEmailOtp(email: string, code: string): string {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedCode = normalizeEmailOtpCode(code);
  const digest = crypto
    .createHmac('sha256', getOtpSecret())
    .update(`${normalizedEmail}:${normalizedCode}`, 'utf8')
    .digest('hex');
  return `otp:v1:${digest}`;
}

export function verifyEmailOtp(email: string, code: string, storedHash: string | null): boolean {
  if (!storedHash?.startsWith('otp:v1:')) {
    return false;
  }
  const expected = hashEmailOtp(email, code);
  const expectedBuffer = Buffer.from(expected);
  const storedBuffer = Buffer.from(storedHash);
  return (
    expectedBuffer.length === storedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, storedBuffer)
  );
}

export function verifyOpaqueToken(token: string, storedHash: string): boolean {
  const expected = hashOpaqueToken(token);
  const expectedBuffer = Buffer.from(expected);
  const storedBuffer = Buffer.from(storedHash);

  return (
    expectedBuffer.length === storedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, storedBuffer)
  );
}

export function isLikelyOpaqueToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(token);
}

export async function verifyLegacyBcryptToken(
  token: string,
  storedHash: string | null
): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('$2')) {
    return false;
  }

  return bcrypt.compare(token, storedHash);
}

export function hashRateLimitIdentifier(identifier: string): string {
  return crypto
    .createHash('sha256')
    .update(identifier.trim().toLowerCase(), 'utf8')
    .digest('hex');
}
