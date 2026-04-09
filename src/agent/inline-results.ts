import type { AgentUiIntent } from './types';

interface InlineResultPersonRef {
  id: string;
  name?: string | null;
  username?: string | null;
}

interface RecentInlineResultsMetadata {
  resultType: string;
  source?: string | null;
  title?: string | null;
  subtitle?: string | null;
  shownCount: number;
  totalCount: number;
  fallbackNavigationTarget?: string | null;
  people: InlineResultPersonRef[];
  updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseRecentInlineResults(value: unknown): RecentInlineResultsMetadata | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const resultType = asString(record.resultType) || 'people';
  const people = Array.isArray(record.people)
    ? record.people
        .map((item) => {
          const person = asRecord(item);
          const id = asString(person?.id);
          if (!id) {
            return null;
          }

          return {
            id,
            name: asString(person?.name),
            username: asString(person?.username),
          };
        })
        .filter((item) => item !== null) as InlineResultPersonRef[]
    : [];

  if (people.length === 0) {
    return null;
  }

  return {
    resultType,
    source: asString(record.source),
    title: asString(record.title),
    subtitle: asString(record.subtitle),
    shownCount: asNumber(record.shownCount) ?? people.length,
    totalCount: asNumber(record.totalCount) ?? people.length,
    fallbackNavigationTarget: asString(record.fallbackNavigationTarget),
    people,
    updatedAt: asString(record.updatedAt) || new Date().toISOString(),
  };
}

function parseVisibleInlineResultIds(surfaceContext: Record<string, unknown> = {}): string[] {
  const rawValue = surfaceContext.inlineResultUserIds;

  if (typeof rawValue === 'string') {
    return rawValue
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (Array.isArray(rawValue)) {
    return rawValue
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
  }

  return [];
}

function orderPeopleForPrompt(
  metadata: RecentInlineResultsMetadata,
  surfaceContext: Record<string, unknown> = {}
): InlineResultPersonRef[] {
  const visibleIds = parseVisibleInlineResultIds(surfaceContext);
  if (visibleIds.length === 0) {
    return metadata.people;
  }

  const personById = new Map(metadata.people.map((person) => [person.id, person]));
  const orderedVisible = visibleIds
    .map((id) => personById.get(id))
    .filter((person): person is InlineResultPersonRef => Boolean(person));

  return orderedVisible.length > 0 ? orderedVisible : metadata.people;
}

function resolveOrdinalIndex(normalizedInput: string, count: number): number | null {
  if (count <= 0) {
    return null;
  }

  const ordinalMatchers: Array<{ pattern: RegExp; index: number | 'last' }> = [
    { pattern: /\b(first|1st)\b/, index: 0 },
    { pattern: /\b(second|2nd)\b/, index: 1 },
    { pattern: /\b(third|3rd)\b/, index: 2 },
    { pattern: /\b(fourth|4th)\b/, index: 3 },
    { pattern: /\b(fifth|5th)\b/, index: 4 },
    { pattern: /\b(last)\b/, index: 'last' },
  ];

  for (const matcher of ordinalMatchers) {
    if (!matcher.pattern.test(normalizedInput)) {
      continue;
    }

    if (matcher.index === 'last') {
      return Math.max(0, count - 1);
    }

    return matcher.index < count ? matcher.index : null;
  }

  const numericMatch = normalizedInput.match(/\b(\d+)(?:st|nd|rd|th)?\s+(?:one|person|profile|match|result)\b/);
  if (!numericMatch) {
    return null;
  }

  const numericIndex = Number(numericMatch[1]) - 1;
  return numericIndex >= 0 && numericIndex < count ? numericIndex : null;
}

export function extractRecentInlineResultsMetadata(
  uiIntents: AgentUiIntent[] = []
): RecentInlineResultsMetadata | null {
  const inlineIntent = [...uiIntents]
    .reverse()
    .find((intent) => intent.type === 'show_inline_results' && asRecord(intent.payload));

  if (!inlineIntent) {
    return null;
  }

  const payload = asRecord(inlineIntent.payload);
  if (!payload) {
    return null;
  }

  const people = Array.isArray(payload.people)
    ? payload.people
        .map((item) => {
          const person = asRecord(item);
          const id = asString(person?.id);
          if (!id) {
            return null;
          }

          return {
            id,
            name: asString(person?.name),
            username: asString(person?.username),
          };
        })
        .filter((item) => item !== null) as InlineResultPersonRef[]
    : [];

  if (people.length === 0) {
    return null;
  }

  return {
    resultType: asString(payload.resultType) || 'people',
    source: asString(payload.source),
    title: asString(payload.title),
    subtitle: asString(payload.subtitle),
    shownCount: asNumber(payload.shownCount) ?? people.length,
    totalCount: asNumber(payload.totalCount) ?? people.length,
    fallbackNavigationTarget: asString(payload.fallbackNavigationTarget),
    people,
    updatedAt: new Date().toISOString(),
  };
}

export function mergeSessionMetadataWithInlineResults(
  existingMetadata: unknown,
  uiIntents: AgentUiIntent[] = []
): Record<string, unknown> | null {
  const baseMetadata = asRecord(existingMetadata) || {};
  const recentInlineResults = extractRecentInlineResultsMetadata(uiIntents);

  if (!recentInlineResults) {
    return Object.keys(baseMetadata).length > 0 ? { ...baseMetadata } : null;
  }

  return {
    ...baseMetadata,
    recentInlineResults,
  };
}

export function buildInlineResultsPromptContext(
  sessionMetadata: unknown,
  surfaceContext: Record<string, unknown> = {}
): string | null {
  const metadataRecord = asRecord(sessionMetadata);
  const recentInlineResults = parseRecentInlineResults(metadataRecord?.recentInlineResults);

  if (!recentInlineResults || recentInlineResults.resultType !== 'people') {
    return null;
  }

  const orderedPeople = orderPeopleForPrompt(recentInlineResults, surfaceContext).slice(0, 6);
  if (orderedPeople.length === 0) {
    return null;
  }

  const visibleIds = parseVisibleInlineResultIds(surfaceContext);
  const label = visibleIds.length > 0 ? 'Visible inline people results' : 'Recent inline people results';
  const compactList = orderedPeople
    .map((person, index) => {
      const displayName = person.name || person.username || 'Unknown';
      const username = person.username ? ` (@${person.username})` : '';
      return `[${index + 1}] ${displayName}${username} id=${person.id}`;
    })
    .join('; ');

  return `${label}: ${compactList}. If the user refers to first, second, third, fourth, fifth, or last, use these exact ids.`;
}

export function resolveInlineReferencedUserId(
  inputText: string,
  sessionMetadata: unknown,
  surfaceContext: Record<string, unknown> = {}
): string | null {
  const metadataRecord = asRecord(sessionMetadata);
  const recentInlineResults = parseRecentInlineResults(metadataRecord?.recentInlineResults);

  if (!recentInlineResults || recentInlineResults.resultType !== 'people') {
    return null;
  }

  const orderedPeople = orderPeopleForPrompt(recentInlineResults, surfaceContext);
  if (orderedPeople.length === 0) {
    return null;
  }

  const normalizedInput = inputText.trim().toLowerCase();
  const ordinalIndex = resolveOrdinalIndex(normalizedInput, orderedPeople.length);
  if (ordinalIndex !== null) {
    return orderedPeople[ordinalIndex]?.id || null;
  }

  const personRefs = [...orderedPeople].sort((left, right) => {
    const leftLength = (left.name || left.username || '').length;
    const rightLength = (right.name || right.username || '').length;
    return rightLength - leftLength;
  });

  for (const person of personRefs) {
    const candidates = [person.name, person.username]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value && value.length >= 3));

    if (candidates.some((candidate) => normalizedInput.includes(candidate))) {
      return person.id;
    }
  }

  return null;
}
