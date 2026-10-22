/**
 * Ensures a value from req.params or req.query is a single string.
 * Express types can be string | string[] | ParsedQs; this normalizes to string | undefined.
 */
export function ensureString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
  return undefined;
}
