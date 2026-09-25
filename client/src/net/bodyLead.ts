// Predictive snapshot bodies: a dynamic body in free fall (a cannonball, a
// launched ball, a meteor's rock after it has left its arc) drawn ahead of the
// dynamic-body render time, up to the data the client already has.
// docs/netcode-tuning.md#predictive-snapshot-bodies-the-debris-lead-for-cannonballs-and-meteors
//
// The dynamic-body render clock trails the server by its interpolation delay
// (15-21 ms on loopback, 60-80 ms on LTE), and part of that is buffer: the
// newest snapshot is usually some way ahead of the render time. A body in free
// fall is exactly where its samples say while it touches nothing (the last
// two show the fall: interpolation.ts `freeFallAcceleration`), so it can be
// drawn later on its path, nearer where the server has it now, from samples
// the client already holds.
//
// This is the city's predictive debris (city/presentation.ts `setLeadHorizon`,
// commit 67569d12) for the snapshot stream:
//
// - **A lead per body**, in server us past the render time. Its goal is the
//   stream's horizon (`BodyLeadHorizon`: by default a low quantile of how far
//   ahead of the render time the previous snapshot still was when the next
//   one arrived) while the body's last two samples show free fall, and 0
//   otherwise; never more than `capTicks` past the body's own newest sample.
//   A body leaving the stream gets a goal of 0.
// - **The lead moves as playback speed, never as a jump.** It follows its
//   goal at `rise` / `fall` ticks per tick of render time, so the body plays at
//   (1 - fall) to (1 + rise) times real speed while it changes. A new body
//   starts at no lead (it is drawn as before and speeds up into it).
// - **A revision is met in time, not space** (`warp`). When new data moves the
//   path the body was drawn on (a contact inside the lead), the lead drops to
//   where the revised path passes closest to the pose on screen, if that
//   makes the correction `warpGain` of what it was; it is regained at the
//   rise rate.
//
// Drawing past the data (the `arrival` horizon, a negative back-off, an
// overshoot bound) is built and opt-in: in Netlab every such arm corrected
// more in view. Players, vehicles and bodies at rest or in contact are drawn
// exactly as before (their lead is 0). Off (`?bodyLead=0`, lab `BODY_LEAD=0`)
// every body is drawn at the render time.

import { freeFallAcceleration, type DynamicBodySample } from './interpolation';
import { SERVER_TICK_US } from './protocol';

type V3 = [number, number, number];

export interface BodyLeadConfig {
  /** Whether bodies are drawn ahead at all. */
  enabled: boolean;
  /** Ticks subtracted from the smoothed arrival horizon (negative: past it). */
  backoffTicks: number;
  /** Furthest past its own newest sample a body's lead goal may take it, ticks. */
  capTicks: number;
  /**
   * Metres a body may be drawn past its newest sample (0: no bound): the goal
   * past the newest sample is at most this over the body's speed. A contact
   * inside that span is overshot by at most this much before its sample
   * arrives (the correction); a fast projectile gets only the lead its speed
   * can afford.
   */
  maxOvershootM: number;
  /** Most lead, ticks. */
  maxLeadTicks: number;
  /** Lead change per tick of render time, up and down. */
  rise: number;
  fall: number;
  /** Meet a revision in time (`warp`). */
  warp: boolean;
  /** Smoothing time constant of the `arrival` horizon, ms of local time. */
  horizonTauMs: number;
  /**
   * How the horizon is reckoned (`BodyLeadHorizon`):
   * - `data`: a low quantile (`quantile`, over the last `window` arrivals)
   *   of how far the previous snapshot ran ahead of the render time at the
   *   moment the next one arrived: the lead at which a body refreshed every
   *   snapshot is drawn from data it already has, all but that share of the
   *   time.
   * - `arrival`: how far each snapshot runs ahead of the render time as it
   *   arrives, smoothed: the newest data at its freshest, so the body is
   *   extrapolated past it for up to a snapshot interval before the next.
   */
  horizonMode: 'data' | 'arrival';
  quantile: number;
  window: number;
  /** A revision is met in time when that brings the pose on screen this much closer (share of the correction). */
  warpGain: number;
}

const LAB_ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

function setting(labName: string, urlName: string): string | null {
  const lab = LAB_ENV[labName];
  if (lab !== undefined && lab !== '') return lab;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get(urlName);
  } catch {
    return null;
  }
}

function numberSetting(labName: string, urlName: string, fallback: number): number {
  const raw = setting(labName, urlName);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * On by default: measured in Netlab v2 (4 captures x 5 links x 2 seeds), it
 * cuts free-falling bodies' pos@now p50 by 17-29% and p99 by 6-15% on
 * loopback and LAN with every correction counter there unchanged, and 18-30%
 * on LTE, which corrects slightly more. `?bodyLead=0` (lab `BODY_LEAD=0`)
 * draws every body at the render time, as before.
 */
export const BODY_LEAD_DEFAULT_ENABLED = true;

export function resolveBodyLeadConfig(): BodyLeadConfig {
  const enabled = setting('BODY_LEAD', 'bodyLead');
  return {
    enabled: enabled === null ? BODY_LEAD_DEFAULT_ENABLED : enabled !== '0' && enabled !== 'off',
    backoffTicks: numberSetting('BODY_LEAD_BACKOFF', 'bodyLeadBackoff', 0),
    capTicks: numberSetting('BODY_LEAD_CAP', 'bodyLeadCap', 1),
    maxOvershootM: Math.max(0, numberSetting('BODY_LEAD_OVERSHOOT_M', 'bodyLeadOvershoot', 0)),
    maxLeadTicks: numberSetting('BODY_LEAD_MAX', 'bodyLeadMax', 6),
    rise: Math.min(0.95, Math.max(0, numberSetting('BODY_LEAD_RISE', 'bodyLeadRise', 0.5))),
    fall: Math.min(0.95, Math.max(0, numberSetting('BODY_LEAD_FALL', 'bodyLeadFall', 0.5))),
    warp: numberSetting('BODY_LEAD_WARP', 'bodyLeadWarp', 1) !== 0,
    horizonTauMs: Math.max(1, numberSetting('BODY_LEAD_TAU_MS', 'bodyLeadTauMs', 500)),
    horizonMode: setting('BODY_LEAD_HORIZON', 'bodyLeadHorizon') === 'arrival' ? 'arrival' : 'data',
    quantile: Math.min(0.5, Math.max(0, numberSetting('BODY_LEAD_Q', 'bodyLeadQ', 0.1))),
    window: Math.max(8, Math.round(numberSetting('BODY_LEAD_WINDOW', 'bodyLeadWindow', 120))),
    warpGain: Math.min(1, Math.max(0, numberSetting('BODY_LEAD_WARP_GAIN', 'bodyLeadWarpGain', 0.8))),
  };
}

/** Resolved once per page (the lab sets its environment before it starts). */
export const BODY_LEAD_CONFIG: BodyLeadConfig = resolveBodyLeadConfig();

/**
 * How far past the dynamic-body render time the newest data runs: at each
 * newest snapshot's arrival, its server time less the render time then,
 * smoothed over `horizonTauMs` of local time. Less the back-off and within
 * [0, maxLeadTicks], it is the lead a free-falling body is drawn at.
 */
export class BodyLeadHorizon {
  private smoothedUs: number | null = null;
  private lastLocalUs = 0;
  /** `data`: the previous newest snapshot's time, and the gaps seen just before each arrival (a ring). */
  private previousNewestUs: number | null = null;
  private readonly gaps: Float64Array;
  private gapCount = 0;
  private gapNext = 0;
  private quantileUs: number | null = null;

  constructor(private readonly config: BodyLeadConfig = BODY_LEAD_CONFIG) {
    this.gaps = new Float64Array(config.window);
  }

  /** A newest snapshot at `newestServerUs` arrived at `localUs`, when the render time was `renderUs`. */
  observeArrival(newestServerUs: number, renderUs: number, localUs: number): void {
    const ahead = newestServerUs - renderUs;
    if (!Number.isFinite(ahead)) return;
    if (this.previousNewestUs !== null && newestServerUs > this.previousNewestUs) {
      this.gaps[this.gapNext] = this.previousNewestUs - renderUs;
      this.gapNext = (this.gapNext + 1) % this.gaps.length;
      this.gapCount = Math.min(this.gapCount + 1, this.gaps.length);
      this.quantileUs = null;
    }
    this.previousNewestUs = newestServerUs;
    if (this.smoothedUs === null || localUs < this.lastLocalUs - 1_000_000) {
      this.smoothedUs = ahead;
    } else {
      const dt = Math.max(0, localUs - this.lastLocalUs) / 1000;
      const alpha = 1 - Math.exp(-dt / this.config.horizonTauMs);
      this.smoothedUs += alpha * (ahead - this.smoothedUs);
    }
    this.lastLocalUs = localUs;
  }

  /** The smoothed lead of the newest data over the render time, us (0 before any). */
  get aheadUs(): number {
    return this.smoothedUs ?? 0;
  }

  /** The `data` quantile of the gap before each arrival, us (null before two arrivals). */
  get dataGapUs(): number | null {
    if (this.gapCount === 0) return null;
    if (this.quantileUs === null) {
      const sorted = Array.from(this.gaps.subarray(0, this.gapCount)).sort((a, b) => a - b);
      this.quantileUs = sorted[Math.min(sorted.length - 1, Math.floor(this.config.quantile * sorted.length))];
    }
    return this.quantileUs;
  }

  /** The lead a free-falling body is drawn at, us; 0 when off. */
  horizonUs(): number {
    if (!this.config.enabled) return 0;
    const base = this.config.horizonMode === 'data' ? this.dataGapUs : this.smoothedUs;
    if (base === null) return 0;
    const us = base - this.config.backoffTicks * SERVER_TICK_US;
    return Math.min(Math.max(0, us), this.config.maxLeadTicks * SERVER_TICK_US);
  }

  reset(): void {
    this.smoothedUs = null;
    this.lastLocalUs = 0;
    this.previousNewestUs = null;
    this.gapCount = 0;
    this.gapNext = 0;
    this.quantileUs = null;
  }
}

/** Whether a body's last two samples show free fall. */
export function inFreeFall(samples: readonly DynamicBodySample[]): boolean {
  const n = samples.length;
  return n >= 2 && freeFallAcceleration(samples[n - 2], samples[n - 1]) !== 0;
}

/** `warp`: corrections it considers, the candidate times, and how much closer the warped time must be. */
export const WARP_MIN_CORRECTION_M = 0.1;
const WARP_STEPS = 16;

export interface BodyLeadCounters {
  /** Revisions of a leading body's drawn path met in time. */
  warps: number;
  /** Server ms of lead those gave up. */
  warpedMs: number;
}

/**
 * One body's lead. `advance` once per drawn frame (idempotent for the same
 * render time), then `drawn` with the pose drawn at the time it returned.
 */
export class BodyLeadTrack {
  private leadUs = 0;
  private lastRenderUs: number | null = null;
  private lastDrawUs: number | null = null;
  private lastPosition: V3 | null = null;

  /** The lead in use, us. */
  get lead(): number {
    return this.leadUs;
  }

  /**
   * The draw time for render time `renderUs`: the lead moved toward its goal
   * (`horizonUs` while `samples` shows free fall, else 0; at most `capTicks`
   * past the newest sample) at the bounded rates, after meeting any revision
   * of the path it drew last frame (`sampleAt`: the body's draw at an explicit
   * time, with what has arrived since).
   */
  advance(
    renderUs: number,
    samples: readonly DynamicBodySample[],
    horizonUs: number,
    config: BodyLeadConfig,
    sampleAt: (serverUs: number) => ArrayLike<number> | null,
    counters?: BodyLeadCounters,
  ): number {
    if (this.lastRenderUs === null || renderUs < this.lastRenderUs - 1_000_000) {
      // A new body (or a seek): drawn at the render time, as before.
      this.leadUs = 0;
      this.lastRenderUs = renderUs;
      this.lastDrawUs = null;
      this.lastPosition = null;
      return renderUs;
    }
    const elapsed = Math.max(0, renderUs - this.lastRenderUs);
    if (elapsed === 0 && this.lastDrawUs !== null) {
      return this.lastDrawUs;
    }
    if (config.warp && this.leadUs > 0 && this.lastDrawUs !== null && this.lastPosition !== null) {
      this.warpToRevision(sampleAt, config.warpGain, counters);
    }
    let goal = 0;
    if (horizonUs > 0 && samples.length > 0 && inFreeFall(samples)) {
      const newest = samples[samples.length - 1];
      let pastUs = config.capTicks * SERVER_TICK_US;
      if (config.maxOvershootM > 0) {
        const speed = Math.hypot(newest.velocity[0], newest.velocity[1], newest.velocity[2]);
        if (speed > 0) pastUs = Math.min(pastUs, (config.maxOvershootM / speed) * 1e6);
      }
      goal = Math.max(0, Math.min(horizonUs, newest.serverTimeUs + pastUs - renderUs));
    }
    if (goal > this.leadUs) {
      this.leadUs = Math.min(goal, this.leadUs + elapsed * config.rise);
    } else if (goal < this.leadUs) {
      this.leadUs = Math.max(goal, this.leadUs - elapsed * config.fall);
    }
    this.lastRenderUs = renderUs;
    this.lastDrawUs = renderUs + this.leadUs;
    return this.lastDrawUs;
  }

  /** The pose drawn at the time `advance` returned. */
  drawn(position: ArrayLike<number>): void {
    this.lastPosition = [position[0], position[1], position[2]];
  }

  /**
   * New data moved the path under the pose on screen (the last draw): drop
   * the lead to the time, between the render time then and that draw, where
   * the revised path passes closest to it, if that halves the correction.
   * The case is a contact inside the lead: a falling ball drawn past its
   * newest sample runs on through the ground it has just bounced off; met at
   * the bounce, it is where it is drawn and leaves it with its new velocity.
   */
  private warpToRevision(
    sampleAt: (serverUs: number) => ArrayLike<number> | null,
    gain: number,
    counters?: BodyLeadCounters,
  ): void {
    const drawnAt = this.lastDrawUs!;
    const drawn = this.lastPosition!;
    const revised = sampleAt(drawnAt);
    if (!revised) return;
    const distance = dist(drawn, revised);
    if (distance <= WARP_MIN_CORRECTION_M) return;
    const earliest = drawnAt - this.leadUs;
    let bestUs = drawnAt;
    let bestDistance = distance;
    for (let step = 1; step <= WARP_STEPS; step += 1) {
      const t = drawnAt - ((drawnAt - earliest) * step) / WARP_STEPS;
      const p = sampleAt(t);
      if (!p) continue;
      const d = dist(drawn, p);
      if (d < bestDistance) {
        bestDistance = d;
        bestUs = t;
      }
    }
    if (bestDistance > distance * gain) return;
    this.leadUs = Math.max(0, this.leadUs - (drawnAt - bestUs));
    if (counters) {
      counters.warps += 1;
      counters.warpedMs += (drawnAt - bestUs) / 1000;
    }
  }
}

function dist(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
