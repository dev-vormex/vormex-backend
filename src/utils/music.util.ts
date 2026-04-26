type JsonRecord = Record<string, unknown>;

export interface StoredMusicAttachment {
  audioId: string;
  title: string;
  artist: string | null;
  albumArt: string | null;
  audioUrl: string | null;
  durationMs: number | null;
  source: string | null;
  startTimeMs: number | null;
}

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeUrl(value: unknown): string | null {
  const raw = asTrimmedString(value);
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return null;
}

export function parseStoredMusicAttachment(value: unknown): StoredMusicAttachment | null {
  if (!value) return null;

  let normalizedValue = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
      normalizedValue = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  const record = asRecord(normalizedValue);
  const audioId = asTrimmedString(record.audioId) || asTrimmedString(record.id);
  const title = asTrimmedString(record.title);

  if (!audioId || !title) {
    return null;
  }

  return {
    audioId,
    title,
    artist: asTrimmedString(record.artist),
    albumArt: normalizeUrl(record.albumArt),
    audioUrl: normalizeUrl(record.audioUrl),
    durationMs: asNumber(record.durationMs),
    source: asTrimmedString(record.source),
    startTimeMs: asNumber(record.startTimeMs),
  };
}
