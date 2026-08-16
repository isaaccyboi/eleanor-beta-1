/**
 * A small in-memory sliding-window rate limiter.
 *
 * Good enough for a single beta deployment protecting its own API spend from
 * one runaway account — a bug in a client, not necessarily malice. It does
 * not survive a restart and is not shared across processes; a multi-instance
 * deployment would need a shared store (Redis, etc.) instead.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {}

  /**
   * True if `key` is still under budget, and records this call as a hit if
   * so. A rejected call is not recorded — it didn't happen, so it shouldn't
   * consume a future slot.
   */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.maxHits) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
