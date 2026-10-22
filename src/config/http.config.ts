export function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) {
    return process.env.NODE_ENV === 'production' ? 1 : true;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : value;
}

// Middleware — add comma-separated origins via CORS_EXTRA_ORIGINS (e.g. admin on Vercel)
const defaultAllowedOrigins = [
  'http://localhost:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
  'https://vormex.in',
  'https://www.vormex.in',
];
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...extraOrigins]);

function isAllowedLocalNetworkOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  return /^https?:\/\/(172\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):(3000|3001)$/.test(
    origin
  );
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}

export function isAllowedRequestOrigin(origin: string | undefined): boolean {
  if (!origin) {
    // Native/mobile clients and same-origin non-browser tools may omit Origin.
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  return allowedOrigins.has(normalizedOrigin) || isAllowedLocalNetworkOrigin(normalizedOrigin);
}
