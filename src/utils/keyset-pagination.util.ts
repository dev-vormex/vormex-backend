import { createHmac, timingSafeEqual } from 'crypto';

export interface KeysetCursor {
  t?: string | null;
  id: string;
  scope?: string;
}

const CURSOR_VERSION = 1;

function cursorSecret(): string {
  const secret = process.env.PAGINATION_CURSOR_SECRET || process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error('PAGINATION_CURSOR_SECRET, JWT_SECRET, or ENCRYPTION_KEY must be configured for cursor pagination.');
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac('sha256', cursorSecret()).update(payload).digest('base64url');
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  const payload = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...cursor }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeKeysetCursor(value: unknown, scope?: string): KeysetCursor | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;

  try {
    const expected = sign(payload);
    if (
      expected.length !== signature.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: number;
      t?: string | null;
      id?: unknown;
      scope?: string;
    };
    if (decoded.v !== CURSOR_VERSION || typeof decoded.id !== 'string') return null;
    if (scope && decoded.scope !== scope) return null;
    if (decoded.t !== null && decoded.t !== undefined && typeof decoded.t !== 'string') return null;
    return { t: decoded.t ?? null, id: decoded.id, scope: decoded.scope };
  } catch {
    return null;
  }
}

export function decodeLegacyDateCursor(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.includes('.')) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function decodeLegacyIdCursor(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.includes('.') ? null : value;
}

export function clampPageSize(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

export function createdAtDescKeysetWhere(cursor: KeysetCursor | null): Record<string, unknown> | null {
  return dateDescKeysetWhere(cursor, 'createdAt');
}

export function dateDescKeysetWhere(
  cursor: KeysetCursor | null,
  fieldName: string
): Record<string, unknown> | null {
  if (!cursor?.t) return null;
  const cursorDate = new Date(cursor.t);
  if (Number.isNaN(cursorDate.getTime())) return null;
  return {
    OR: [
      { [fieldName]: { lt: cursorDate } },
      { [fieldName]: cursorDate, id: { lt: cursor.id } },
    ],
  };
}

export function nullableDateDescIdAscWhere(
  cursor: KeysetCursor | null,
  fieldName: string
): Record<string, unknown> | null {
  if (!cursor) return null;
  if (!cursor.t) {
    return {
      [fieldName]: null,
      id: { gt: cursor.id },
    };
  }

  const cursorDate = new Date(cursor.t);
  if (Number.isNaN(cursorDate.getTime())) return null;
  return {
    OR: [
      { [fieldName]: { lt: cursorDate } },
      { [fieldName]: cursorDate, id: { gt: cursor.id } },
      { [fieldName]: null },
    ],
  };
}
