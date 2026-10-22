import type { Prisma } from '@prisma/client';

import { asNumber } from "./value-parsing.util";
import { asRecord } from "./value-parsing.util";
import { asTrimmedString } from "./value-parsing.util";


export interface StoredMusicAttachment extends Prisma.InputJsonObject {
  audioId: string;
  title: string;
  artist: string | null;
  albumArt: string | null;
  audioUrl: string | null;
  durationMs: number | null;
  source: string | null;
  startTimeMs: number | null;
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
