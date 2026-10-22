export function isPrismaConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { code?: string; message?: string };
  return maybeError.code === 'P1001' || String(maybeError.message || '').includes("Can't reach database server");
}
