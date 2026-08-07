import { HttpError } from "./auth";

/**
 * A fixed-window per-account limiter, held in process memory.
 *
 * Deliberately not a shared store: purchases are already atomic and
 * idempotent, so this is not what protects the ledger — it only stops a
 * scripted client generating ledger noise and mail spam. One portal process
 * counting on its own is enough for that.
 */
export class RateLimiter {
  private readonly hits = new Map<number, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** Throws 429 when the account is over its limit, otherwise records a hit. */
  check(accountId: number, now: number = Date.now()): void {
    this.evictExpired(now);
    const recent = (this.hits.get(accountId) ?? []).filter(
      (t) => now - t < this.windowMs
    );
    if (recent.length >= this.limit) {
      throw new HttpError(429, "Too many purchases at once — wait a minute.");
    }
    recent.push(now);
    this.hits.set(accountId, recent);
  }

  /**
   * Drop accounts whose hits have all aged out. Without this the map keeps one
   * entry per account that has ever bought anything for the life of the
   * process: the array empties, but the key never goes away.
   */
  private evictExpired(now: number): void {
    for (const [accountId, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) {
        this.hits.delete(accountId);
      }
    }
  }

  /** How many accounts are currently being tracked. */
  get size(): number {
    return this.hits.size;
  }

  reset(): void {
    this.hits.clear();
  }
}
