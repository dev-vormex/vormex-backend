import crypto from 'node:crypto';

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;

  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function hashNormalizedValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashEmail(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  return normalized ? hashNormalizedValue(normalized) : null;
}
