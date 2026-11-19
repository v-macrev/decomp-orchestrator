// SPDX-License-Identifier: AGPL-3.0-or-later
// Continuous-refill token bucket. Allows a negative balance ("debt") so that reservations made
// from estimates can be reconciled against actual usage after the response arrives.
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    public capacity: number,
    /** tokens per millisecond */
    public refillPerMs: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  static perMinute(perMinute: number, now?: () => number) {
    return new TokenBucket(perMinute, perMinute / 60_000, now);
  }

  private refill() {
    const t = this.now();
    if (t > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
      this.last = t;
    }
  }

  get level() {
    this.refill();
    return this.tokens;
  }

  /** Fraction of capacity currently available (0..1, negative when in debt). */
  get headroom() {
    return this.level / this.capacity;
  }

  /** ms until `n` tokens are available (0 if now). A request larger than capacity waits for a full bucket. */
  timeUntil(n: number): number {
    this.refill();
    const need = Math.min(n, this.capacity) - this.tokens;
    return need <= 0 ? 0 : Math.ceil(need / this.refillPerMs);
  }

  tryTake(n: number): boolean {
    if (this.timeUntil(n) > 0) return false;
    this.tokens -= n;
    return true;
  }

  /** Adjust by a delta after the fact (positive refunds, negative debits; may go into debt). */
  adjust(delta: number) {
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens + delta);
  }

  /** Clamp to what the provider says is actually remaining (from rate-limit response headers). */
  clampTo(remaining: number) {
    this.refill();
    if (remaining < this.tokens) this.tokens = remaining;
  }

  drain() {
    this.refill();
    this.tokens = Math.min(this.tokens, 0);
  }
}
