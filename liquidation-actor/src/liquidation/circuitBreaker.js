export class SourceCircuitBreaker {
  constructor({ maxConsecutive403 = 10, maxConsecutive5xx = 20, maxRateLimited = 30 } = {}) {
    this.maxConsecutive403 = maxConsecutive403;
    this.maxConsecutive5xx = maxConsecutive5xx;
    this.maxRateLimited = maxRateLimited;
    this.consecutive403 = 0;
    this.consecutive5xx = 0;
    this.rateLimited = 0;
    this.openReason = null;
    this.openedAt = null;
  }

  note(status) {
    if (status === 403) this.consecutive403 += 1; else if (status > 0) this.consecutive403 = 0;
    if (status >= 500) this.consecutive5xx += 1; else if (status > 0) this.consecutive5xx = 0;
    if (status === 429) this.rateLimited += 1;

    if (!this.openReason && this.consecutive403 >= this.maxConsecutive403) this.openReason = `consecutive_403:${this.consecutive403}`;
    if (!this.openReason && this.consecutive5xx >= this.maxConsecutive5xx) this.openReason = `consecutive_5xx:${this.consecutive5xx}`;
    if (!this.openReason && this.rateLimited >= this.maxRateLimited) this.openReason = `rate_limit_events:${this.rateLimited}`;
    if (this.openReason && !this.openedAt) this.openedAt = new Date().toISOString();
    return this.openReason;
  }

  assertClosed() {
    if (this.openReason) throw new Error(`LIQUIDATION_CIRCUIT_OPEN:${this.openReason}`);
  }

  snapshot() {
    return {
      circuit_open: !!this.openReason,
      circuit_open_reason: this.openReason,
      consecutive_403: this.consecutive403,
      consecutive_5xx: this.consecutive5xx,
      rate_limit_events: this.rateLimited,
      opened_at: this.openedAt,
    };
  }
}