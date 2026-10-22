
export function readNote(notes: Record<string, unknown> | undefined, key: string): string | null {
  const value = notes?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

