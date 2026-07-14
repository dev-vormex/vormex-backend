/**
 * Bounded in-process memoization with TTL, for hot-path lookups whose values
 * tolerate short staleness (sender identity, premium flags, conversation
 * participants). Complements the Redis cache: zero network cost, per-instance.
 *
 * Stores the in-flight promise so concurrent callers share one computation.
 * Failed computations are evicted immediately so the next call retries.
 */
type MemoEntry<T> = {
  value: Promise<T>;
  expiresAt: number;
};

export class TtlMemo<T> {
  private entries = new Map<string, MemoEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5000
  ) {}

  get(key: string, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.value;
    }

    const value = compute();
    value.catch(() => {
      const current = this.entries.get(key);
      if (current && current.value === value) {
        this.entries.delete(key);
      }
    });

    if (this.entries.size >= this.maxEntries) {
      this.evict(now);
    }

    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    // Still full after dropping expired entries: drop oldest-inserted first.
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
