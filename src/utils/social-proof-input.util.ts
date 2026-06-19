export type SocialProofMetadataValue = string | number | boolean | null;
export type SocialProofMetadata = Record<string, SocialProofMetadataValue>;

export interface SocialProofInputResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRACKING_TEXT_PATTERN = /^[A-Za-z0-9 _./:-]+$/;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TRACKING_TEXT_LENGTH = 96;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_STRING_LENGTH = 256;

function fail<T>(error: string): SocialProofInputResult<T> {
  return { ok: false, error };
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

export function normalizeRequiredTrackingId(
  value: unknown,
  fieldName: string
): SocialProofInputResult<string> {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fail(`${fieldName} is required`);
  }

  if (normalized.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(normalized)) {
    return fail(`${fieldName} is invalid`);
  }

  return { ok: true, value: normalized };
}

export function normalizeOptionalTrackingText(
  value: unknown,
  fieldName: string
): SocialProofInputResult<string | undefined> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return fail(`${fieldName} must be a string`);
  }

  if (normalized.length > MAX_TRACKING_TEXT_LENGTH || !TRACKING_TEXT_PATTERN.test(normalized)) {
    return fail(`${fieldName} is invalid`);
  }

  return { ok: true, value: normalized };
}

export function normalizeActivityType(value: unknown): SocialProofInputResult<string> {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fail('activityType is required');
  }

  if (normalized.length > MAX_TRACKING_TEXT_LENGTH || !TRACKING_TEXT_PATTERN.test(normalized)) {
    return fail('activityType is invalid');
  }

  return { ok: true, value: normalized };
}

export function normalizeSocialProofMetadata(value: unknown): SocialProofInputResult<SocialProofMetadata> {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail('metadata must be an object');
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    return fail(`metadata must contain ${MAX_METADATA_KEYS} keys or fewer`);
  }

  const normalized: SocialProofMetadata = {};
  for (const [key, metadataValue] of entries) {
    const normalizedKey = key.trim();
    if (
      normalizedKey.length === 0 ||
      normalizedKey.length > MAX_TRACKING_TEXT_LENGTH ||
      !METADATA_KEY_PATTERN.test(normalizedKey)
    ) {
      return fail('metadata contains an invalid key');
    }

    if (metadataValue === null) {
      normalized[normalizedKey] = null;
      continue;
    }

    if (typeof metadataValue === 'boolean') {
      normalized[normalizedKey] = metadataValue;
      continue;
    }

    if (typeof metadataValue === 'number') {
      if (!Number.isFinite(metadataValue)) {
        return fail('metadata contains an invalid number');
      }
      normalized[normalizedKey] = metadataValue;
      continue;
    }

    if (typeof metadataValue === 'string') {
      const normalizedValue = metadataValue.trim();
      if (normalizedValue.length > MAX_METADATA_STRING_LENGTH) {
        return fail(`metadata string values must be ${MAX_METADATA_STRING_LENGTH} characters or less`);
      }
      normalized[normalizedKey] = normalizedValue;
      continue;
    }

    return fail('metadata values must be strings, numbers, booleans, or null');
  }

  return { ok: true, value: normalized };
}
