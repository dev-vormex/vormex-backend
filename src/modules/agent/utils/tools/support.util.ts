
export type ConnectionState = 'none' | 'pending_sent' | 'pending_received' | 'connected';

export function clip(text: string | null | undefined, maxLength: number): string | null {
  if (!text) return null;
  const normalized = text.trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

export function compactStringList(
  values: Array<string | null | undefined>,
  maxItems: number = values.length
): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  });

  return items.slice(0, maxItems);
}
