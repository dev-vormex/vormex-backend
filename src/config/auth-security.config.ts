import { assertUsableAuthSecret, isWeakAuthSecret } from '../utils/jwt.util';

const PUBLIC_ENV_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'PUBLIC_'];
const SENSITIVE_PUBLIC_ENV_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PRIVATE|JWT|ENCRYPTION_KEY|API_KEY|CLIENT_SECRET)/i;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function findSensitivePublicEnvNames(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return Object.keys(env).filter((name) => {
    const hasPublicPrefix = PUBLIC_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    return hasPublicPrefix && SENSITIVE_PUBLIC_ENV_PATTERN.test(name);
  });
}

function assertHexSecret(name: string, value: string | undefined, hexChars: number): void {
  if (!value || !new RegExp(`^[a-f0-9]{${hexChars}}$`, 'i').test(value)) {
    throw new Error(`${name} must be exactly ${hexChars} hex characters`);
  }
}

function assertCookieConfig(): void {
  const sameSite = (process.env.AUTH_COOKIE_SAME_SITE || '').toLowerCase();
  const secure = process.env.AUTH_COOKIE_SECURE;

  if (sameSite === 'none' && secure === 'false') {
    throw new Error('AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true');
  }

  if (isProduction() && secure === 'false') {
    throw new Error('AUTH_COOKIE_SECURE=false is not allowed in production');
  }
}

export function validateAuthRuntimeConfig(): void {
  const publicSecretNames = findSensitivePublicEnvNames();
  if (publicSecretNames.length > 0) {
    throw new Error(
      `Sensitive values must not use frontend-exposed env prefixes: ${publicSecretNames.join(', ')}`
    );
  }

  if (process.env.JWT_SECRET || isProduction()) {
    assertUsableAuthSecret('JWT_SECRET', process.env.JWT_SECRET);
  }

  if (isProduction() && !process.env.AUTH_CSRF_SECRET) {
    throw new Error('AUTH_CSRF_SECRET is required in production');
  }

  if (process.env.AUTH_CSRF_SECRET) {
    assertUsableAuthSecret('AUTH_CSRF_SECRET', process.env.AUTH_CSRF_SECRET);
  }

  if (isProduction() && process.env.AUTH_CSRF_SECRET === process.env.JWT_SECRET) {
    throw new Error('AUTH_CSRF_SECRET must be different from JWT_SECRET in production');
  }

  if (process.env.JWT_SECRET && isWeakAuthSecret(process.env.JWT_SECRET) && isProduction()) {
    throw new Error('JWT_SECRET is too weak for production');
  }

  assertCookieConfig();
  assertHexSecret('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY, 64);

  if (process.env.ENCRYPTION_KEY_PREVIOUS) {
    assertHexSecret('ENCRYPTION_KEY_PREVIOUS', process.env.ENCRYPTION_KEY_PREVIOUS, 64);
    if (
      process.env.ENCRYPTION_KEY_PREVIOUS.toLowerCase() ===
      process.env.ENCRYPTION_KEY?.toLowerCase()
    ) {
      throw new Error('ENCRYPTION_KEY_PREVIOUS must be different from ENCRYPTION_KEY');
    }
  }
}
