// The local player's energy as the HUD shows it, between server messages.
//
// The server sends energy when the displayed integer changes (at most 10 a
// second) and otherwise within a second (server/src/energy_stream.rs), not
// every tick. Energy drains continuously, so holding the last value would make
// the debug overlay's decimal freeze and jump. Between messages this follows
// the drain rate measured from the last two, bounded so it never shows less
// than the integer the server last reported: the HUD's integer (EnergyBar
// floors) is always the server's, and gains (a battery, a respawn) apply at
// once rather than being smoothed.

/** Drains slower than this are not extrapolated (units per ms). */
const MIN_DRAIN_PER_MS = 1e-6;
/** Faster than any real drain; a larger measured rate is a glitch (units per ms). */
const MAX_DRAIN_PER_MS = 0.1;
/** Samples further apart than this say nothing about the current rate. */
const RATE_WINDOW_MS = 2000;

export class EnergyDisplay {
  private last = 0;
  private lastAtMs = Number.NEGATIVE_INFINITY;
  private drainPerMs = 0;

  /** A value from the server, received at `nowMs`. */
  onSample(value: number, nowMs: number): void {
    const dt = nowMs - this.lastAtMs;
    if (value < this.last && dt > 0 && dt <= RATE_WINDOW_MS) {
      const rate = (this.last - value) / dt;
      this.drainPerMs = rate <= MAX_DRAIN_PER_MS ? rate : 0;
    } else {
      this.drainPerMs = 0;
    }
    this.last = value;
    this.lastAtMs = nowMs;
  }

  /** The value to show at `nowMs`. */
  value(nowMs: number): number {
    if (this.drainPerMs < MIN_DRAIN_PER_MS) return this.last;
    const elapsed = Math.max(0, Math.min(nowMs - this.lastAtMs, RATE_WINDOW_MS));
    const floor = Math.floor(this.last);
    return Math.max(floor, this.last - this.drainPerMs * elapsed);
  }

  /** The last value the server sent. */
  get serverValue(): number {
    return this.last;
  }

  reset(): void {
    this.last = 0;
    this.lastAtMs = Number.NEGATIVE_INFINITY;
    this.drainPerMs = 0;
  }
}
