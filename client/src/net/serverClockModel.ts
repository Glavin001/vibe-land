// The server-clock estimator, in TypeScript.
//
// A line-for-line copy of `ServerClockEstimator` in netcode/src/clock_sync.rs,
// which the live client runs through WASM (`WasmClockSync`). This copy is what
// runs where WASM is not loaded: unit tests, and the offline tape tools under
// scripts/perf. serverClockModel.test.ts runs both over the same traces and
// requires them to agree, so a change to one is a change to both.
//
// What it does, briefly (clock_sync.rs has the long form): server time on the
// wire is tick x 16.67 ms, and a server that cannot hold 60 Hz advances it
// slower than wall time. The estimator measures that rate -- from the server's
// wall-clock stamp when the snapshot carries one, from arrivals otherwise --
// models server time as the newest sample advanced at the rate by at most one
// snapshot interval, and follows the model with an output that never goes
// backwards and never snaps backwards.

export const RATE_WINDOW_US = 1_000_000;
export const RATE_MIN_SPAN_US = 250_000;
export const RATE_SMOOTHING_TAU_US = 300_000;
export const RATE_MIN = 0.02;
export const RATE_MAX = 2.0;
export const WALL_OFFSET_WINDOW_US = 4_000_000;
export const ARRIVAL_HISTORY = 128;
export const DELAY_QUANTILE = 0.95;
export const MAX_DELAY_US = 250_000;
export const SLEW_TAU_US = 300_000;
export const MAX_CATCH_UP = 1.5;
export const SNAP_FORWARD_US = 1_000_000;
export const RESET_BACKWARDS_US = 1_000_000;

/** The surface WasmClockSync and TsServerClock share. */
export interface ServerClockModel {
  observeRtt(rttMs: number): void;
  observeServerTime(serverUs: number, localUs: number): void;
  observeServerTimeWithWall(serverUs: number, wallUs: number, localUs: number): void;
  serverNowUs(localUs: number): number;
  getClockOffsetUs(): number;
  getRate(): number;
  hasWallClock(): boolean;
  getJitterUs(): number;
  getInterpolationDelayMs(): number;
  getSnapshotIntervalMs(): number;
  getRttMs(): number;
  free(): void;
}

type ClockSample = {
  serverUs: number;
  arrivalUs: number;
  producedUs: number;
  wallUs: number | null;
};

/** Jacobson/Karels RTT estimator (clock_sync.rs `RttEstimator`). */
class RttEstimator {
  private srttUs = 0;
  private rttvarUs = 0;
  private initialized = false;

  observe(rttUs: number): void {
    if (!this.initialized) {
      this.srttUs = rttUs;
      this.rttvarUs = rttUs / 2;
      this.initialized = true;
      return;
    }
    const maxAccepted = Math.min(this.srttUs + 3 * this.rttvarUs, this.srttUs * 3, this.srttUs + 500_000);
    const minAccepted = this.srttUs * 1.2;
    if (rttUs > maxAccepted || (rttUs < minAccepted && rttUs < this.srttUs)) return;
    const prev = this.srttUs;
    this.srttUs = (1 - 1 / 12) * this.srttUs + (1 / 12) * rttUs;
    this.rttvarUs = (1 - 1 / 6) * this.rttvarUs + (1 / 6) * Math.abs(rttUs - prev);
  }

  rttUs(): number {
    return this.srttUs;
  }

  jitterUs(): number {
    return this.rttvarUs / 2;
  }
}

/** Nearest-rank quantile; sorts `values`. 0 when empty. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const rank = Math.min(values.length, Math.max(1, Math.ceil(q * values.length)));
  return values[rank - 1];
}

export class TsServerClock implements ServerClockModel {
  private readonly rtt = new RttEstimator();
  private readonly samples: ClockSample[] = [];
  private latest: ClockSample | null = null;
  private rate = 1;
  private rateMeasured = false;
  private wallUnwrapped: { raw: number; unwrapped: number } | null = null;
  private wallOffsetUs: number | null = null;
  private readonly arrivals: Array<{ drain: number; step: number }> = [];
  private delayUs: number;
  private snapshotIntervalUs: number;
  private outServerUs = 0;
  private outTargetUs = 0;
  private outLocalUs = 0;
  private outInitialized = false;

  constructor(private readonly simHz = 60) {
    this.delayUs = this.tickUs();
    this.snapshotIntervalUs = this.tickUs();
  }

  private tickUs(): number {
    return 1_000_000 / Math.max(1, this.simHz);
  }

  observeRtt(rttMs: number): void {
    this.rtt.observe(rttMs * 1000);
  }

  observeServerTime(serverUs: number, localUs: number): void {
    this.observe(serverUs, localUs, null);
  }

  observeServerTimeWithWall(serverUs: number, wallUs: number, localUs: number): void {
    this.observe(serverUs, localUs, wallUs >>> 0);
  }

  private observe(serverUs: number, localUs: number, wall: number | null): void {
    if (this.latest) {
      if (localUs < this.latest.arrivalUs - RESET_BACKWARDS_US) {
        this.resetTimeline();
      } else if (serverUs <= this.latest.serverUs) {
        return;
      }
    }

    const wallUs = wall === null ? null : this.unwrapWall(wall);
    if (wallUs === null) {
      this.wallUnwrapped = null;
      this.wallOffsetUs = null;
    }

    const sample: ClockSample = { serverUs, arrivalUs: localUs, producedUs: localUs, wallUs };
    const keepFrom = localUs - Math.max(RATE_WINDOW_US, WALL_OFFSET_WINDOW_US);
    while (this.samples.length > 0 && this.samples[0].arrivalUs < keepFrom) this.samples.shift();
    if (wallUs !== null) {
      const from = localUs - WALL_OFFSET_WINDOW_US;
      let offset = localUs - wallUs;
      for (const s of this.samples) {
        if (s.arrivalUs >= from && s.wallUs !== null) offset = Math.min(offset, s.arrivalUs - s.wallUs);
      }
      this.wallOffsetUs = offset;
      sample.producedUs = wallUs + offset;
    }
    this.samples.push(sample);

    const sinceLastUs = this.latest ? Math.max(0, localUs - this.latest.arrivalUs) : 0;
    this.updateRate(localUs, sinceLastUs);

    if (this.latest) {
      const gapUs = Math.max(0, localUs - this.latest.arrivalUs);
      this.arrivals.push({ drain: gapUs * this.rate, step: serverUs - this.latest.serverUs });
      while (this.arrivals.length > ARRIVAL_HISTORY) this.arrivals.shift();
      this.updateDelay();
    }

    this.latest = sample;
    if (!this.outInitialized) {
      this.outServerUs = this.modelUs(localUs);
      this.outTargetUs = this.outServerUs;
      this.outLocalUs = localUs;
      this.outInitialized = true;
    }
  }

  private unwrapWall(raw: number): number {
    let unwrapped: number;
    if (!this.wallUnwrapped) {
      unwrapped = raw;
    } else {
      // (raw - last) as i32: the signed 32-bit difference.
      unwrapped = this.wallUnwrapped.unwrapped + ((raw - this.wallUnwrapped.raw) | 0);
    }
    this.wallUnwrapped = { raw, unwrapped };
    return unwrapped;
  }

  private updateRate(localUs: number, sinceLastUs: number): void {
    const from = localUs - RATE_WINDOW_US;
    const first = this.samples.find((s) => s.arrivalUs >= from);
    if (!first) return;
    const last = this.samples[this.samples.length - 1];
    // From wall stamps the rate is exact over the window; from arrivals it
    // carries network jitter and is smoothed on local time.
    const byWall = first.wallUs !== null && last.wallUs !== null;
    const spanUs = byWall ? last.wallUs! - first.wallUs! : last.arrivalUs - first.arrivalUs;
    const smoothing = byWall ? 1 : 1 - Math.exp(-sinceLastUs / RATE_SMOOTHING_TAU_US);
    if (spanUs < RATE_MIN_SPAN_US) return;
    const measured = Math.min(RATE_MAX, Math.max(RATE_MIN, (last.serverUs - first.serverUs) / spanUs));
    if (this.rateMeasured) {
      this.rate += (measured - this.rate) * smoothing;
    } else {
      this.rate = measured;
      this.rateMeasured = true;
    }
  }

  private updateDelay(): void {
    const drain = quantile(this.arrivals.map((a) => a.drain), DELAY_QUANTILE);
    this.snapshotIntervalUs = Math.max(1, quantile(this.arrivals.map((a) => a.step), 0.5));
    this.delayUs = Math.min(MAX_DELAY_US, Math.max(drain, this.snapshotIntervalUs));
  }

  private resetTimeline(): void {
    this.samples.length = 0;
    this.latest = null;
    this.arrivals.length = 0;
    this.wallUnwrapped = null;
    this.wallOffsetUs = null;
    this.rate = 1;
    this.rateMeasured = false;
    this.outInitialized = false;
    this.delayUs = this.tickUs();
    this.snapshotIntervalUs = this.tickUs();
  }

  private modelUs(localUs: number): number {
    const latest = this.latest;
    if (!latest) return localUs;
    const ahead = Math.min(this.snapshotIntervalUs, Math.max(0, this.rate * (localUs - latest.producedUs)));
    return latest.serverUs + ahead + this.rtt.rttUs() / 2;
  }

  serverNowUs(localUs: number): number {
    if (!this.latest) return localUs;
    const target = this.modelUs(localUs);
    if (!this.outInitialized || localUs < this.outLocalUs - RESET_BACKWARDS_US) {
      this.outServerUs = target;
      this.outTargetUs = target;
      this.outLocalUs = localUs;
      this.outInitialized = true;
      return target;
    }
    const dt = localUs - this.outLocalUs;
    if (dt <= 0) return this.outServerUs;
    const error = this.outServerUs - this.outTargetUs;
    let next: number;
    if (target - this.outServerUs > SNAP_FORWARD_US) {
      next = target;
    } else {
      const followed = target + error * Math.exp(-dt / SLEW_TAU_US);
      next = Math.min(this.outServerUs + this.rate * dt * MAX_CATCH_UP, Math.max(this.outServerUs, followed));
    }
    this.outServerUs = next;
    this.outTargetUs = target;
    this.outLocalUs = localUs;
    return next;
  }

  getClockOffsetUs(): number {
    if (this.outInitialized) return this.outServerUs - this.outLocalUs;
    if (this.latest) return this.latest.serverUs - this.latest.arrivalUs;
    return 0;
  }

  getRate(): number {
    return this.rate;
  }

  hasWallClock(): boolean {
    return this.wallOffsetUs !== null;
  }

  getJitterUs(): number {
    return this.rtt.jitterUs();
  }

  getInterpolationDelayMs(): number {
    return this.delayUs / 1000;
  }

  getSnapshotIntervalMs(): number {
    return this.snapshotIntervalUs / 1000;
  }

  getRttMs(): number {
    return this.rtt.rttUs() / 1000;
  }

  free(): void {}
}
