/**
 * A token bucket per connection (#37): `ratePerSec` tokens refill
 * continuously up to `burst`; each message takes one. Awareness and sync
 * updates get one bucket each, so a runaway client cannot amplify through
 * the room's fan-out.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Take one token; false when the bucket is empty (the message should be dropped). */
  take(): boolean {
    const at = this.now();
    const elapsed = Math.max(0, at - this.last) / 1000;
    this.last = at;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
