/** Rolling one-hour spend limiter (LLM calls, voice characters, previews). */
export class UsageLimiter {
  private events: Array<{ t: number; n: number }> = [];
  constructor(public limitPerHour: number) {}
  used(now = Date.now()) {
    this.events = this.events.filter((e) => now - e.t < 3600_000);
    return this.events.reduce((s, e) => s + e.n, 0);
  }
  canSpend(n: number, now = Date.now()) { return this.limitPerHour <= 0 || this.used(now) + n <= this.limitPerHour; }
  spend(n: number, now = Date.now()) { this.events.push({ t: now, n }); }
}
