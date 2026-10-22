
export function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > 1 ? normalized : null;
}

