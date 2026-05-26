const SENSITIVE_KEY_PATTERN =
  /(password|passcode|secret|token|refresh|authorization|cookie|session|api[_-]?key|private[_-]?key|otp|email|phone)/i;

export function redactAgentPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[truncated]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactAgentPayload(item, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[redacted]'
        : redactAgentPayload(nestedValue, depth + 1);
    }
    return output;
  }

  return String(value);
}
