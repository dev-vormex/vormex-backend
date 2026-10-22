
export function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return parseRetryAfterSeconds(value[0]);
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.ceil(value);
  }

  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }

  const dateValue = Date.parse(value);
  if (Number.isFinite(dateValue)) {
    return Math.max(1, Math.ceil((dateValue - Date.now()) / 1000));
  }

  return undefined;
}

