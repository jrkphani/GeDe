/**
 * A token bucket per connection (#37): `ratePerSec` tokens refill
 * continuously up to `burst`; each message takes one (or, for the bytes
 * bucket of #99, as many as it is long). Awareness, sync messages and sync
 * bytes get one bucket each, so a runaway client cannot amplify through the
 * room's fan-out.
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

  /**
   * Take `cost` tokens; false when the bucket holds fewer (the message should
   * be dropped or the connection closed). A cost above the burst can never be
   * paid: the caller has already bounded it (`WS_MAX_UPDATE_BYTES`).
   */
  take(cost = 1): boolean {
    const at = this.now();
    const elapsed = Math.max(0, at - this.last) / 1000;
    this.last = at;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
