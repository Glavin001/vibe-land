// Buffered, render-time presentation of sparse rigid-body snapshots.
//
// Ported from /root/workspace/destruction-codec/src/presentation.rs
// (2026-08-10): timestamped snapshot buffering, cubic Hermite translation,
// shortest-path slerp, bounded class-aware extrapolation, and critically
// damped late-path reconciliation. `sample` is stateful and expects
// monotonically nondecreasing render ticks.

import {
  EPSILON,
  Quat,
  Vec3,
  qFromScaledAxis,
  qConjugate,
  qMul,
  qNormalize,
  qSlerp,
  qRotate,
  qToRotationVector,
  vAdd,
  vClone,
  vCross,
  vDistance,
  vLength,
  vLerp,
  vScale,
  vSub,
  vZero,
} from './vec';

export enum PresentationClass {
  Quiescent = 0,
  Ballistic = 1,
  ContactActive = 2,
  ImpactBurst = 3,
}

export interface PresentationConfig {
  interpolationDelayTicks: number;
  maxExtrapolationTicks: number;
  /** Approximate time in seconds for a late correction to settle. */
  correctionSeconds: number;
  /** Duration of one physics tick in seconds. */
  dt: number;
  gravity: Vec3;
  /** Larger path revisions are treated as discontinuous lifecycle moves. */
  snapDistanceMeters: number;
}

/**
 * How fast a correction may carry a body, m/s, and the longest it may take.
 *
 * Debris in this world travels at 40-70 m/s, so a correction that moves at 30
 * reads as the body hurrying rather than as something teleporting, and stays
 * slower than the motion it is correcting. The cap stops a very large
 * correction from being visible as a slow drift for several seconds.
 */
const CORRECTION_SPEED_MPS = 30;
const MAX_CORRECTION_SECONDS = 1.0;

/**
 * Glide large corrections instead of abandoning them. OFF.
 *
 * It does what it says -- 3,548 presented discontinuities a collapse became 6
 * -- and it is not an improvement to watch. Judged in play: "I don't like the
 * glide, it's not really better." A snap is wrong for one frame and the eye
 * discards it; a glide is wrong for up to a second and is coherent, so the
 * piece appears to travel a path the physics never took.
 *
 * The reason it changed nothing real is that the correction was never the
 * fault. It is the client being told, late, that a body is metres from where
 * it has been drawing it -- and that gap comes from the body not being
 * streamed, not from how the gap is closed. /city?glideCorrections=1 to see it.
 */
const GLIDE_LARGE_CORRECTIONS = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '')
      .get('glideCorrections') === '1';
  } catch {
    return false;
  }
})();

/** Explicit 60 Hz config (≈100 ms delay / 133 ms max extrapolation). */
export function presentationConfig60Hz(): PresentationConfig {
  return {
    interpolationDelayTicks: 6,
    maxExtrapolationTicks: 8,
    // 0.25, not 0.1: a body outside the ranked interest set is served about
    // one record per second, so its accumulated extrapolation error arrives
    // as ONE correction per second — and a 0.1 s glide of that size reads as
    // the body being punted upward on a 1 Hz metronome (reported live, phone
    // session, settling debris). 0.25 s turns the same correction into a
    // drift the eye forgives; near bodies get corrections every record, far
    // smaller, and are unaffected in practice.
    correctionSeconds: 0.25,
    dt: 1 / 60,
    // The world's gravity: Earth's since the physics went back to 9.81
    // (physx-bridge `world_gravity_magnitude`, VIBE_WORLD_GRAVITY). This was
    // 20 while the world fell at 20; left there, every ballistic record was
    // extrapolated at twice the gravity it falls at -- 9 cm off after the
    // 133 ms window, as far off as not modelling gravity at all. The server
    // encoder models this value (destruction/src/encoder.rs
    // CLIENT_EXTRAPOLATION_GRAVITY_Y); change both together.
    gravity: [0, -9.81, 0],
    snapDistanceMeters: 5,
  };
}

export interface MotionSnapshot {
  tick: number;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  class: PresentationClass;
}

export interface PresentedState {
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  positionCorrection: Vec3;
  rotationCorrectionDegrees: number;
}

const defaultState = (): PresentedState => ({
  position: vZero(),
  rotation: [0, 0, 0, 1],
  linearVelocity: vZero(),
  angularVelocity: vZero(),
  positionCorrection: vZero(),
  rotationCorrectionDegrees: 0,
});

interface Correction {
  position: Vec3;
  linearVelocity: Vec3;
  rotation: Vec3;
  angularVelocity: Vec3;
}

const zeroCorrection = (): Correction => ({
  position: vZero(),
  linearVelocity: vZero(),
  rotation: vZero(),
  angularVelocity: vZero(),
});

interface PreviousSample {
  renderTick: number;
  /**
   * The tick that sample was drawn at: render tick less the playout delay,
   * plus the track's lead. The revision re-anchor evaluates the revised path
   * here, so a lead or delay that moved since cannot make it jump.
   */
  targetTick: number;
  state: PresentedState;
  revision: number;
  /** Set by `seedPresented`: the lead is taken at once on the first sample. */
  seeded?: boolean;
}

/**
 * Predictive presentation (dead reckoning ahead of the playout delay). OFF
 * unless a caller sets a lead (`setLeadHorizon`); see `CityClient`
 * PREDICTIVE_PRESENTATION and docs/netcode-tuning.md#predictive-debris-dead-reckoning-ahead-of-the-playout-delay.
 *
 * A track with a lead is drawn `lead` ticks past the shared presentation
 * tick. The lead follows its target at a bounded rate, in ticks per tick of
 * render time: rising, the body plays up to (1 + rise) times real speed;
 * falling, no slower than (1 - fall). Below 1, so the drawn tick never goes
 * backwards. A change of lead is therefore a change of playback speed, never
 * a jump (the earlier attempt switched it with the record class and jumped
 * by the lead at every flip).
 */
export interface LeadRates {
  rise: number;
  fall: number;
}

/**
 * Discontinuities this track presented on purpose.
 *
 * Each one is a designed escape hatch — an unsmoothed rewind, a correction
 * abandoned as too large, a knot pair too far apart to interpolate — and each
 * is visible on screen as a jump. They are reported rather than logged so a
 * measurement harness can count them without this module depending on it.
 */
export type PresentationAnomalyKind =
  /** Render time moved backwards; the correction is dropped and the pose rewinds. */
  | 'clock_rollback'
  /** Correction exceeded snapDistanceMeters and was abandoned — hard snap onto the new path. */
  | 'correction_snap'
  /** Two consecutive snapshots too far apart to interpolate; sampled as a step function. */
  | 'implausible_jump';

export interface PresentationAnomaly {
  kind: PresentationAnomalyKind;
  /** Metres for snap/jump; ticks rewound for clock_rollback. */
  magnitude: number;
  /**
   * For clock_rollback: how much correction was still in flight when it was
   * dropped. Zero means nothing was being smoothed and nothing was lost.
   */
  abandonedCorrectionM?: number;
}

export type PresentationAnomalyListener = (anomaly: PresentationAnomaly) => void;

/**
 * Below this, a decaying correction is treated as finished.
 *
 * A tenth of a millimetre -- an order of magnitude under the client's own
 * PRESENTATION_EPSILON_M (1e-4 m), at which point it already declines to
 * redraw the chunk. Exists because critically-damped decay is asymptotic.
 */
const SETTLED_EPSILON = 1e-5;

/** `warpToRevision`: corrections it considers, the candidate ticks, and how
 *  much closer the warped anchor must be. */
const WARP_MIN_CORRECTION_M = 0.5;
const WARP_STEPS = 16;
const WARP_MIN_GAIN = 0.5;

export class PresentationTrack {
  private readonly config: PresentationConfig;
  private readonly linearDamping: number;
  private readonly angularDamping: number;
  private snapshots: MotionSnapshot[] = [];
  private correction: Correction = zeroCorrection();
  private previous: PreviousSample | null = null;
  private revision = 0;
  private onAnomaly: PresentationAnomalyListener | null = null;
  private onCorrection: ((metres: number, warped: boolean) => void) | null = null;
  /** Current lead, ticks past the presentation tick (0: the classic track). */
  private lead = 0;
  /** Lead for a body whose newest record is ballistic, and the share of it
   *  a body in contact gets. */
  private leadHorizon = 0;
  private leadContactShare = 0;
  private leadRates: LeadRates = { rise: 0.5, fall: 0.5 };
  private leadMaxOvershootM = 0;
  /**
   * Whether the lead lengthens the extrapolation clamp. Off, a record is
   * extrapolated no further than a classic track takes it (and held at the
   * same pose), only sooner: what the encoder models for a client it does not
   * know leads. On, the clamp follows the lead, as the encoder models a
   * predictive client (`ClientBodyState::presented_at_ahead`).
   */
  private leadExtendsClamp = true;
  /**
   * The furthest past its own newest record a body may be drawn, ticks
   * (NaN: no cap). The `data` horizon is the stream's newest tick; a body
   * the stream refreshes less often -- outside the ranked interest set, or
   * on a link the rate controller has thinned -- is behind that, and
   * leading it would extrapolate it where the classic track interpolates.
   */
  private leadDataCapTicks = Number.NaN;
  /** Lowest a leading ballistic extrapolation carries a body's centre (m);
   *  NaN: no floor. See `setLeadFloor`. */
  private leadFloorY = Number.NaN;

  /** See `leadDataCapTicks`. */
  setLeadDataCap(ticks: number): void {
    this.leadDataCapTicks = ticks;
  }

  /**
   * A leading track extrapolates a ballistic record further past its tick
   * than a classic one, and without a floor it carries a body that has just
   * landed on the (flat, y = 0) city ground metres into it before the
   * landing's record arrives: Netlab, systematic c1 on LTE, 1,601 debris
   * chunk-frames hidden below -4 m. Its centre stops falling at this height
   * instead. The encoder models the same floor.
   */
  setLeadFloor(y: number): void {
    this.leadFloorY = y;
  }

  /**
   * Observe every revision re-anchor: the distance between the pose on
   * screen and the revised path, which the track then glides away (or snaps,
   * beyond `snapDistanceMeters`), and whether a leading track met it by
   * giving up lead (`warpToRevision`). A measurement hook, like the anomaly
   * one.
   */
  setCorrectionListener(listener: ((metres: number, warped: boolean) => void) | null): void {
    this.onCorrection = listener;
  }

  /**
   * Draw this body `horizon` ticks past the presentation tick while its
   * newest record is ballistic, and `horizon * contactShare` otherwise.
   * 0 (the default) is the classic track, exactly.
   */
  setLeadHorizon(
    horizon: number,
    contactShare: number,
    rates?: LeadRates,
    maxOvershootM = 0,
    extendClamp = true,
  ): void {
    this.leadExtendsClamp = extendClamp;
    this.leadMaxOvershootM = Number.isFinite(maxOvershootM) ? Math.max(0, maxOvershootM) : 0;
    this.leadHorizon = Number.isFinite(horizon) ? Math.max(0, horizon) : 0;
    this.leadContactShare = Number.isFinite(contactShare) ? Math.min(1, Math.max(0, contactShare)) : 0;
    if (rates) {
      this.leadRates = {
        rise: Math.min(0.95, Math.max(0, rates.rise)),
        fall: Math.min(0.95, Math.max(0, rates.fall)),
      };
    }
  }

  /** The lead this track is drawn at, ticks. */
  currentLead(): number {
    return this.lead;
  }

  private clampExtension(): number {
    return this.leadExtendsClamp ? this.lead : 0;
  }

  /** Whether this track has ever been given a lead. */
  private predictive(): boolean {
    return this.leadHorizon > 0 || this.lead !== 0;
  }

  private leadTarget(): number {
    if (this.leadHorizon <= 0 || this.snapshots.length === 0) {
      return 0;
    }
    const newest = this.snapshots[this.snapshots.length - 1];
    if (newest.class === PresentationClass.Quiescent) {
      return 0;
    }
    const lead = newest.class === PresentationClass.Ballistic
      ? this.leadHorizon
      : this.leadHorizon * this.leadContactShare;
    return this.leadMaxOvershootM > 0 ? Math.min(lead, this.overshootBound(newest)) : lead;
  }

  /**
   * The most lead that keeps an unforeseen stop within `leadMaxOvershootM`.
   *
   * A record arrives about one playout delay before the presentation reaches
   * its tick. A body drawn more than that delay ahead has already been drawn
   * past a contact the record then reports, by (lead - delay) ticks of its
   * speed: that is the correction, and past `snapDistanceMeters` a snap. So
   * a fast body gets only the lead its speed can afford beyond the delay.
   * The encoder models the same bound (`Lead::for_motion`).
   */
  private overshootBound(newest: MotionSnapshot): number {
    const speed = vLength(newest.linearVelocity);
    if (speed <= EPSILON) {
      return Number.POSITIVE_INFINITY;
    }
    return this.config.interpolationDelayTicks + this.leadMaxOvershootM / (speed * this.config.dt);
  }

  /** Observe presented discontinuities. Pass null to stop. */
  setAnomalyListener(listener: PresentationAnomalyListener | null): void {
    this.onAnomaly = listener;
  }

  constructor(config: PresentationConfig, linearDamping = 0, angularDamping = 0) {
    this.config = { ...config };
    if (!Number.isFinite(this.config.dt) || this.config.dt <= 0) {
      this.config.dt = 1 / 60;
    }
    if (!Number.isFinite(this.config.correctionSeconds) || this.config.correctionSeconds < 0) {
      this.config.correctionSeconds = 0;
    }
    if (!this.config.gravity.every(Number.isFinite)) {
      this.config.gravity = vZero();
    }
    if (!Number.isFinite(this.config.snapDistanceMeters) || this.config.snapDistanceMeters <= 0) {
      this.config.snapDistanceMeters = 5;
    }
    this.linearDamping = Number.isFinite(linearDamping) ? Math.max(0, linearDamping) : 0;
    this.angularDamping = Number.isFinite(angularDamping) ? Math.max(0, angularDamping) : 0;
  }

  bufferedSnapshots(): number {
    return this.snapshots.length;
  }

  /**
   * Declares where this body is already being drawn, before any snapshot.
   *
   * A promoted island starts life with its chunks already on screen as part of
   * the structure they broke off. Its first streamed pose is the fracture tick
   * -- ahead of the ~interpolation delay everything around it renders at -- so
   * adopting it directly teleports every chunk in the island. Seeding the
   * on-screen pose instead makes the first `sample` take the same late-packet
   * reconciliation path a revised trajectory takes: the island glides from
   * where it was drawn onto the authoritative path over `correctionSeconds`.
   *
   * Call on a fresh track before the first `push`. `push` bumps the revision,
   * so leaving the seed at revision 0 is what arms that reconciliation.
   */
  seedPresented(
    state: {
      position: Vec3;
      rotation: Quat;
      linearVelocity: Vec3;
      angularVelocity: Vec3;
    },
    renderTick: number,
  ): void {
    if (!Number.isFinite(renderTick)) {
      return;
    }
    if (!state.position.every(Number.isFinite) || !state.rotation.every(Number.isFinite)) {
      return;
    }
    this.previous = {
      renderTick,
      targetTick: renderTick - this.config.interpolationDelayTicks + this.lead,
      seeded: true,
      state: {
        position: vClone(state.position),
        rotation: [...state.rotation] as Quat,
        linearVelocity: vClone(state.linearVelocity),
        angularVelocity: vClone(state.angularVelocity),
        positionCorrection: vZero(),
        rotationCorrectionDegrees: 0,
      },
      revision: this.revision,
    };
  }

  /** Inserts a timestamped snapshot, coalescing snapshots at the same tick. */
  push(snapshot: MotionSnapshot): void {
    const entry: MotionSnapshot = { ...snapshot, rotation: qNormalize(snapshot.rotation) };
    let low = 0;
    let high = this.snapshots.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.snapshots[mid].tick < entry.tick) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (low < this.snapshots.length && this.snapshots[low].tick === entry.tick) {
      this.snapshots[low] = entry;
    } else {
      this.snapshots.splice(low, 0, entry);
    }
    this.revision = (this.revision + 1) | 0;
  }

  /**
   * Re-expresses every buffered pose in a body frame whose origin moved by
   * `deltaLocal` (body-local metres).
   *
   * A body's pose is stated about its centre of mass, so the frame shifts the
   * instant the body sheds members to a fracture. The topology message that
   * announces that shift arrives on the reliable channel and is applied at
   * once, but poses render through `interpolationDelayTicks` of buffering --
   * so without this the buffer holds old-frame poses that get composed with
   * new-frame chunk offsets, drawing every surviving chunk displaced by the
   * centre-of-mass delta until the delay window catches up. That was the
   * visible "jump out, jump back" on every hit.
   *
   * The correction is exact rather than approximate. Chunk rest positions are
   * fixed, so a centre-of-mass move by `delta` shifts every local offset by
   * exactly `-delta`, and a pose `p` with rotation `R` describes the identical
   * world placement in the new frame as `p + R*delta`. Rotation is unchanged
   * (the frames differ by a translation), and velocity picks up the rigid
   * term `w x R*delta` so Hermite tangents stay consistent with the shifted
   * knots.
   *
   * Deliberately does NOT bump `revision`: the buffer describes the same
   * motion through the same world points, so there is nothing for `sample`'s
   * late-path reconciliation to smooth. Treating it as a revision would
   * inject a decaying correction and reintroduce the artefact this removes.
   */
  rebase(deltaLocal: Vec3): void {
    if (!deltaLocal.every(Number.isFinite)) {
      return;
    }
    if (vLength(deltaLocal) <= EPSILON) {
      return;
    }
    for (const snapshot of this.snapshots) {
      const worldDelta = qRotate(snapshot.rotation, deltaLocal);
      snapshot.position = vAdd(snapshot.position, worldDelta);
      snapshot.linearVelocity = vAdd(
        snapshot.linearVelocity,
        vCross(snapshot.angularVelocity, worldDelta),
      );
    }
    if (this.previous) {
      // The on-screen pose is the anchor `sample` reconciles against; leaving
      // it in the old frame would manufacture exactly the discontinuity the
      // snapshot rebase just removed.
      const state = this.previous.state;
      const worldDelta = qRotate(state.rotation, deltaLocal);
      state.position = vAdd(state.position, worldDelta);
      state.linearVelocity = vAdd(
        state.linearVelocity,
        vCross(state.angularVelocity, worldDelta),
      );
    }
  }

  /** Samples the track at a fractional render tick. */
  /**
   * Whether the LAST `sample()` call took the settled fast-path.
   *
   * The contract callers lean on: when true, the returned state was the
   * previous sample's state object, unchanged -- nothing about this track can
   * move again until a new snapshot, revision or clock rollback arrives, all
   * of which come through `push()`. `CityClient` uses that to drop the body
   * from its per-frame walk entirely and re-admit it on the next record.
   */
  lastSampleSettled = false;

  /**
   * The window the CURRENT correction is being spread over, seconds.
   *
   * Stretched for a large correction so the body arrives at a speed debris
   * plausibly moves at instead of being dragged across the map by a fixed
   * quarter second -- which was the reason large corrections used to be
   * abandoned, and abandoning them is what produced the teleport.
   */
  private correctionSecondsActive = 0;

  /**
   * Resize the playout buffer.
   *
   * Per track because each one owns a copy of the config. Callers must slew
   * this rather than step it: `sample` reads at `renderTick - delay`, so
   * changing it by n ticks between frames moves every body by n ticks of its
   * own motion, all at once. That is the artefact the buffer exists to avoid,
   * caused by the buffer.
   */
  setInterpolationDelayTicks(ticks: number): void {
    if (Number.isFinite(ticks) && ticks >= 0) {
      this.config.interpolationDelayTicks = ticks;
    }
  }

  sample(renderTickInput: number): PresentedState {
    this.lastSampleSettled = false;
    if (this.snapshots.length === 0) {
      return defaultState();
    }
    const renderTick = Number.isFinite(renderTickInput) ? renderTickInput : 0;
    this.advanceLead(renderTick);
    const targetTick = renderTick - this.config.interpolationDelayTicks + this.lead;
    if (this.isSettled(renderTick, targetTick)) {
      this.lastSampleSettled = true;
      // Advance the clock but reuse the state: the revision re-anchor below
      // reads `previous.renderTick`, so letting it go stale would mis-anchor
      // the next correction. Nothing else in the record can have moved.
      this.previous!.renderTick = renderTick;
      this.previous!.targetTick = targetTick;
      return this.previous!.state;
    }
    let raw = this.rawState(targetTick);

    const elapsedSeconds = this.previous
      ? Math.max(0, renderTick - this.previous.renderTick) * this.config.dt
      : 0;

    if (this.previous) {
      if (renderTick < this.previous.renderTick) {
        // The rewind itself is usually sub-tick and invisible. What the player
        // sees is the correction being dropped: a smoothing already in flight
        // is abandoned mid-glide, so the pose jumps to the raw path.
        this.onAnomaly?.({
          kind: 'clock_rollback',
          magnitude: this.previous.renderTick - renderTick,
          abandonedCorrectionM: vLength(this.correction.position),
        });
        this.correction = zeroCorrection();
      } else if (this.previous.revision !== this.revision) {
        // Re-anchor the revised path to the pose already on screen so a late
        // packet's path change becomes a continuous correction.
        // A classic track (no lead ever) keeps its original anchor, the
        // previous render tick less TODAY's delay, so it replays exactly as
        // before this option existed.
        let revisedPrevious = this.rawState(
          this.predictive()
            ? this.previous.targetTick
            : this.previous.renderTick - this.config.interpolationDelayTicks,
        );
        // A leading track can meet a revision in time instead of in space:
        // re-anchor where the revised path passes closest to the pose on
        // screen, giving up that much lead (regained at the rise rate).
        const warp = this.warpToRevision(revisedPrevious);
        if (warp) {
          revisedPrevious = warp.state;
          raw = this.rawState(renderTick - this.config.interpolationDelayTicks + this.lead);
        }
        const correction: Correction = {
          position: vSub(this.previous.state.position, revisedPrevious.position),
          linearVelocity: vSub(this.previous.state.linearVelocity, revisedPrevious.linearVelocity),
          rotation: qToRotationVector(
            qMul(this.previous.state.rotation, qConjugate(revisedPrevious.rotation)),
          ),
          angularVelocity: vSub(
            this.previous.state.angularVelocity,
            revisedPrevious.angularVelocity,
          ),
        };
        const correctionDistance = vLength(correction.position);
        this.onCorrection?.(correctionDistance, warp !== null);
        // Abandoning a correction IS the teleport.
        //
        // Zeroing it puts the body straight onto the revised path, which moves
        // it by exactly `correctionDistance` in one frame -- and that is the
        // artefact left in the numbers after everything else was fixed: about
        // three thousand drawn chunk steps over thirty-two metres per tower
        // collapse, all of them on this writer.
        //
        // The reason for abandoning was that gliding a large correction drags
        // the body across the map at whatever speed the fixed quarter-second
        // implies. That is answered by stretching the glide instead of
        // refusing it: the correction is spread over however long it takes to
        // cover at a speed debris plausibly moves at, so the body arrives
        // continuously rather than appearing somewhere else. Beyond
        // `snapDistanceMeters * 24` it is not a correction at all -- it is a
        // different place -- and that still snaps.
        //
        // Every case that used to need the snap now announces itself instead:
        // promotions, wakes, starved re-admissions, structure repairs and
        // resync bootstraps all seed the track explicitly, so what reaches here
        // is an ordinary late packet.
        if (GLIDE_LARGE_CORRECTIONS
          && correctionDistance <= this.config.snapDistanceMeters * 24) {
          this.correction = correction;
          this.correctionSecondsActive = Math.max(
            this.config.correctionSeconds,
            Math.min(MAX_CORRECTION_SECONDS, correctionDistance / CORRECTION_SPEED_MPS),
          );
        } else if (correctionDistance > this.config.snapDistanceMeters) {
          // Reported only when it actually snaps, so the counter means what it
          // says: a discontinuity that was presented, not one that was
          // considered. With gliding on this fires for a correction beyond
          // twenty-four times the glide limit, which is a different place
          // rather than a late packet.
          this.onAnomaly?.({ kind: 'correction_snap', magnitude: correctionDistance });
          this.correction = zeroCorrection();
          this.correctionSecondsActive = this.config.correctionSeconds;
        } else {
          this.correction = correction;
          this.correctionSecondsActive = this.config.correctionSeconds;
        }
      }
    }

    // No correction in flight -- most bodies, most frames -- and the raw
    // state IS the presented state: nothing to decay (a zero correction
    // stays zero, exactly), nothing to add, no quaternion to compose and
    // normalise. `raw` is this call's own object, so it is returned as the
    // state rather than copied into one.
    const state: PresentedState = this.correctionIsZero() ? raw : this.corrected(raw, elapsedSeconds);

    const drawnTick = renderTick - this.config.interpolationDelayTicks + this.lead;
    this.previous = { renderTick, targetTick: drawnTick, state, revision: this.revision };
    this.prune(Math.min(targetTick, drawnTick));
    return state;
  }

  /**
   * On a revision of a leading track: the tick, between the presentation
   * tick and the one last drawn, where the revised path passes closest to
   * the pose on screen, if that is much closer than the revised path at the
   * tick last drawn. The lead drops to it.
   *
   * The case is an impulse the lead ran ahead of: a body at rest struck at
   * tick b is drawn at rest past b until the record arrives, and the revised
   * path there is already metres along (50-80 m/s x the lead beyond the
   * playout delay: Netlab, the live capture on LTE, 5.5-9.5 m, every one a
   * snap). Re-anchored at b instead, the body is where it is drawn, and it
   * starts moving now. An overshoot past a stop gains nothing from this (the
   * revised path's closest point is the stop) and is left alone.
   */
  private warpToRevision(revised: PresentedState): { state: PresentedState } | null {
    const previous = this.previous;
    if (!previous || this.lead <= 0 || !this.predictive()) {
      return null;
    }
    const drawn = previous.state.position;
    const distance = vDistance(drawn, revised.position);
    if (distance <= WARP_MIN_CORRECTION_M) {
      return null;
    }
    let bestTick = previous.targetTick;
    let bestDistance = distance;
    let bestState = revised;
    const earliest = previous.targetTick - this.lead;
    for (let step = 1; step <= WARP_STEPS; step += 1) {
      const tick = previous.targetTick - ((previous.targetTick - earliest) * step) / WARP_STEPS;
      const state = this.rawState(tick);
      const d = vDistance(drawn, state.position);
      if (d < bestDistance) {
        bestDistance = d;
        bestTick = tick;
        bestState = state;
      }
    }
    if (bestDistance > distance * WARP_MIN_GAIN) {
      return null;
    }
    this.lead = Math.max(0, this.lead - (previous.targetTick - bestTick));
    previous.targetTick = bestTick;
    return { state: bestState };
  }

  /** `leadTarget`, under the data cap at this render tick. */
  private leadGoal(renderTick: number): number {
    const target = this.leadTarget();
    if (!(target > 0) || !Number.isFinite(this.leadDataCapTicks)) {
      return target;
    }
    const newest = this.snapshots[this.snapshots.length - 1];
    const presented = renderTick - this.config.interpolationDelayTicks;
    return Math.min(target, Math.max(0, newest.tick + this.leadDataCapTicks - presented));
  }

  /**
   * Move the lead toward its target at the bounded rates. A freshly seeded
   * track takes it at once: its first sample re-anchors to the pose on
   * screen, so the seed's glide covers the lead as well.
   */
  private advanceLead(renderTick: number): void {
    const target = this.leadGoal(renderTick);
    const previous = this.previous;
    if (previous?.seeded) {
      previous.seeded = false;
      if (target !== this.lead) {
        this.lead = target;
        previous.targetTick = previous.renderTick - this.config.interpolationDelayTicks + target;
      }
      return;
    }
    if (target === this.lead) {
      return;
    }
    if (!previous) {
      this.lead = target;
      return;
    }
    const elapsed = Math.max(0, renderTick - previous.renderTick);
    if (target > this.lead) {
      this.lead = Math.min(target, this.lead + elapsed * this.leadRates.rise);
    } else {
      this.lead = Math.max(target, this.lead - elapsed * this.leadRates.fall);
    }
  }

  private correctionIsZero(): boolean {
    const c = this.correction;
    return c.position[0] === 0 && c.position[1] === 0 && c.position[2] === 0
      && c.linearVelocity[0] === 0 && c.linearVelocity[1] === 0 && c.linearVelocity[2] === 0
      && c.rotation[0] === 0 && c.rotation[1] === 0 && c.rotation[2] === 0
      && c.angularVelocity[0] === 0 && c.angularVelocity[1] === 0 && c.angularVelocity[2] === 0;
  }

  private corrected(raw: PresentedState, elapsedSeconds: number): PresentedState {
    this.decayCorrection(elapsedSeconds);
    return {
      position: vAdd(raw.position, this.correction.position),
      rotation: qNormalize(qMul(qFromScaledAxis(this.correction.rotation), raw.rotation)),
      linearVelocity: vAdd(raw.linearVelocity, this.correction.linearVelocity),
      angularVelocity: vAdd(raw.angularVelocity, this.correction.angularVelocity),
      positionCorrection: vClone(this.correction.position),
      rotationCorrectionDegrees: (vLength(this.correction.rotation) * 180) / Math.PI,
    };
  }

  private rawState(targetTick: number): PresentedState {
    const first = this.snapshots[0];
    if (targetTick <= first.tick) {
      return snapshotState(first);
    }
    for (let index = 1; index < this.snapshots.length; index++) {
      const right = this.snapshots[index];
      if (targetTick <= right.tick) {
        return interpolate(
          this.snapshots[index - 1],
          right,
          targetTick,
          this.config.dt,
          this.config.snapDistanceMeters,
          this.config.gravity,
          this.onAnomaly,
        );
      }
    }
    return this.extrapolate(this.snapshots[this.snapshots.length - 1], targetTick);
  }

  private extrapolate(snapshot: MotionSnapshot, targetTick: number): PresentedState {
    // A leading track the server models extrapolates as far past the
    // presentation tick as a classic one does, plus its lead (the encoder
    // models the same clamp: destruction/src/encoder.rs
    // `ClientBodyState::presented_at_ahead`); any other keeps the classic
    // clamp (`leadExtendsClamp`).
    const extraTicks = Math.min(
      Math.max(0, targetTick - snapshot.tick),
      this.config.maxExtrapolationTicks + this.clampExtension(),
    );
    const seconds = extraTicks * this.config.dt;

    if (snapshot.class === PresentationClass.Quiescent) {
      return {
        position: vClone(snapshot.position),
        rotation: snapshot.rotation,
        linearVelocity: vZero(),
        angularVelocity: vZero(),
        positionCorrection: vZero(),
        rotationCorrectionDegrees: 0,
      };
    }

    const gravity =
      snapshot.class === PresentationClass.Ballistic ? this.config.gravity : vZero();
    const [positionDelta, linearVelocity] = dampedTranslation(
      snapshot.linearVelocity,
      gravity,
      this.linearDamping,
      seconds,
    );
    const [angularDelta, angularVelocity] = dampedMotion(
      snapshot.angularVelocity,
      this.angularDamping,
      seconds,
    );

    const position = vAdd(snapshot.position, positionDelta);
    if (
      this.lead > 0
      && snapshot.class === PresentationClass.Ballistic
      && position[1] < this.leadFloorY
    ) {
      // Never below where the record already was: a body under the floor
      // (a pit, a basement) is not lifted, only kept from sinking further.
      position[1] = Math.min(snapshot.position[1], this.leadFloorY);
      linearVelocity[1] = Math.max(0, linearVelocity[1]);
    }
    return {
      position,
      rotation: qNormalize(qMul(qFromScaledAxis(angularDelta), snapshot.rotation)),
      linearVelocity,
      angularVelocity,
      positionCorrection: vZero(),
      rotationCorrectionDegrees: 0,
    };
  }

  private decayCorrection(seconds: number): void {
    const over = this.correctionSecondsActive > 0
      ? this.correctionSecondsActive
      : this.config.correctionSeconds;
    if (over <= EPSILON) {
      this.correction = zeroCorrection();
      return;
    }
    // Four time constants leaves ~9% of a critically damped zero-velocity
    // displacement after the correction window.
    const omega = 4 / over;
    // In place: the correction's arrays are this track's own (built fresh at
    // each re-anchor, copied out when presented), and this ran for every
    // streamed body every frame as a dozen arrays through criticalStep.
    if (seconds > 0) {
      const decay = Math.exp(-omega * seconds);
      criticalStepInPlace(this.correction.position, this.correction.linearVelocity, omega, seconds, decay);
      criticalStepInPlace(this.correction.rotation, this.correction.angularVelocity, omega, seconds, decay);
    }
    // Critically-damped decay is asymptotic, so a correction never actually
    // reaches zero -- it just gets very small and is carried forever. Collapse
    // it once it is far below anything observable (a tenth of a millimetre is
    // an order under the client's own PRESENTATION_EPSILON_M, at which point it
    // already refuses to redraw). Without this, `isSettled` below can never be
    // true and a resting body is re-interpolated every frame for the rest of
    // the session.
    if (
      vLength(this.correction.position) < SETTLED_EPSILON
      && vLength(this.correction.linearVelocity) < SETTLED_EPSILON
      && vLength(this.correction.rotation) < SETTLED_EPSILON
      && vLength(this.correction.angularVelocity) < SETTLED_EPSILON
    ) {
      this.correction = zeroCorrection();
    }
  }

  /**
   * Can `sample` only return what it returned last time?
   *
   * True when nothing can have changed: no new snapshot since the last sample
   * (`revision`), no clock rollback, no correction still decaying, and a raw
   * path that is provably constant -- the final snapshot is Quiescent and the
   * target tick is past it, which `rawState`/`extrapolate` answer with that
   * snapshot's pose regardless of how far past.
   *
   * This is the resting population, and it is most of the city: measured on
   * downtown, 4,219 of 9,764 bodies asleep. Each was being interpolated,
   * corrected, quaternion-normalised and allocated for, every frame, to arrive
   * at the pose it already had -- `samplePresentation` cost 3.4-3.8 ms a frame,
   * more than the entire renderer.
   */
  private isSettled(renderTick: number, targetTick: number): boolean {
    const previous = this.previous;
    if (!previous) return false;
    if (previous.revision !== this.revision) return false;
    if (renderTick < previous.renderTick) return false;
    const last = this.snapshots[this.snapshots.length - 1];
    if (last.class === PresentationClass.Quiescent) {
      if (targetTick <= last.tick) return false;
    } else {
      // Non-quiescent tracks freeze too: `extrapolate` clamps extraTicks at
      // maxExtrapolationTicks for EVERY class, so once the target tick is past
      // the window the raw state is constant in time. Requiring the PREVIOUS
      // sample's target to also be past the window makes the fast-path exact
      // rather than one-frame-early -- `previous.state` is then already the
      // clamped pose, not the last still-decaying one. This is what lets the
      // per-frame walk drop bodies whose records simply stopped, which is how
      // every real body goes quiet (the wire never sends a Quiescent class;
      // fully-settled bodies are deleted by the reliable settle instead).
      const frozenAt = last.tick + this.config.maxExtrapolationTicks + this.clampExtension();
      const previousTarget = this.predictive()
        ? previous.targetTick
        : previous.renderTick - this.config.interpolationDelayTicks;
      if (targetTick < frozenAt || previousTarget < frozenAt) return false;
      if (this.lead !== this.leadGoal(renderTick)) return false;
    }
    return (
      this.correction.position[0] === 0
      && this.correction.position[1] === 0
      && this.correction.position[2] === 0
      && this.correction.rotation[0] === 0
      && this.correction.rotation[1] === 0
      && this.correction.rotation[2] === 0
    );
  }

  private prune(targetTick: number): void {
    while (this.snapshots.length > 2 && this.snapshots[1].tick <= targetTick) {
      this.snapshots.shift();
    }
  }
}

function snapshotState(snapshot: MotionSnapshot): PresentedState {
  return {
    position: vClone(snapshot.position),
    rotation: snapshot.rotation,
    linearVelocity: vClone(snapshot.linearVelocity),
    angularVelocity: vClone(snapshot.angularVelocity),
    positionCorrection: vZero(),
    rotationCorrectionDegrees: 0,
  };
}

/**
 * Include the ballistic term in the plausibility bound. On by default.
 *
 * A switch only so the two can be compared in one build against one collapse:
 * /city?ballisticPlausibility=0 restores the endpoint-speed-only bound this
 * replaced.
 */
const BALLISTIC_PLAUSIBILITY = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '')
      .get('ballisticPlausibility') !== '0';
  } catch {
    return true;
  }
})();

function interpolate(
  left: MotionSnapshot,
  right: MotionSnapshot,
  targetTick: number,
  dt: number,
  snapDistanceMeters: number,
  gravity: Vec3,
  onAnomaly?: PresentationAnomalyListener | null,
): PresentedState {
  const tickSpan = right.tick - left.tick;
  if (tickSpan <= 0) {
    return snapshotState(right);
  }
  const seconds = tickSpan * dt;
  // What the body could have covered between these two knots.
  //
  // The endpoint speeds alone are not that bound, and the case they miss is
  // the commonest thing in a collapse: a chunk that breaks loose at rest,
  // falls, and has stopped again by the next update this client received. Both
  // endpoint velocities are near zero, so the old bound was near zero too, and
  // ten metres of falling read as impossible. A body outside the ranked
  // interest set is served about one record per second -- see
  // `correctionSeconds` below -- and one second of this world's gravity is
  // exactly ten metres. So during any real collapse this rejected honest
  // motion, wholesale, and the rejection is not free: it abandons the
  // interpolation and samples the pair as a STEP FUNCTION, holding the old
  // pose and then snapping to the new one. That is the flicker reported from
  // play, and a report from a live session counted 4,054 of them against 300
  // correction snaps and no clock rollbacks at all.
  //
  // Adding the ballistic term makes the bound cover free fall while leaving it
  // far below what this check exists to catch: a lane reused by another body,
  // or a membership disagreement, which move things by tens to thousands of
  // metres. The same report's worst was 29 km.
  const plausibleMotion =
    Math.max(vLength(left.linearVelocity), vLength(right.linearVelocity)) * seconds
    + (BALLISTIC_PLAUSIBILITY ? 0.5 * vLength(gravity) * seconds * seconds : 0);
  const knotDistance = vDistance(left.position, right.position);
  if (knotDistance > plausibleMotion + snapDistanceMeters) {
    onAnomaly?.({ kind: 'implausible_jump', magnitude: knotDistance });
    return targetTick < right.tick ? snapshotState(left) : snapshotState(right);
  }

  const u = Math.min(1, Math.max(0, (targetTick - left.tick) / tickSpan));
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  // Hermite, written out: this runs for every moving body every frame, and
  // as a chain of vector helpers it was sixteen arrays a body.
  const lp = left.position, lv = left.linearVelocity, rp = right.position, rv = right.linearVelocity;
  const h10s = h10 * seconds;
  const h11s = h11 * seconds;
  const position: Vec3 = [
    lp[0] * h00 + lv[0] * h10s + rp[0] * h01 + rv[0] * h11s,
    lp[1] * h00 + lv[1] * h10s + rp[1] * h01 + rv[1] * h11s,
    lp[2] * h00 + lv[2] * h10s + rp[2] * h01 + rv[2] * h11s,
  ];

  const dh00 = 6 * u2 - 6 * u;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = -dh00;
  const dh11 = 3 * u2 - 2 * u;
  const inv = 1 / seconds;
  const dh10s = dh10 * seconds;
  const dh11s = dh11 * seconds;
  const linearVelocity: Vec3 = [
    (lp[0] * dh00 + lv[0] * dh10s + rp[0] * dh01 + rv[0] * dh11s) * inv,
    (lp[1] * dh00 + lv[1] * dh10s + rp[1] * dh01 + rv[1] * dh11s) * inv,
    (lp[2] * dh00 + lv[2] * dh10s + rp[2] * dh01 + rv[2] * dh11s) * inv,
  ];

  return {
    position,
    rotation: qSlerp(left.rotation, right.rotation, u),
    linearVelocity,
    angularVelocity: vLerp(left.angularVelocity, right.angularVelocity, u),
    positionCorrection: vZero(),
    rotationCorrectionDegrees: 0,
  };
}

function dampedTranslation(
  initialVelocity: Vec3,
  acceleration: Vec3,
  damping: number,
  seconds: number,
): [Vec3, Vec3] {
  if (damping <= EPSILON) {
    return [
      vAdd(vScale(initialVelocity, seconds), vScale(acceleration, 0.5 * seconds * seconds)),
      vAdd(initialVelocity, vScale(acceleration, seconds)),
    ];
  }
  const decay = Math.exp(-damping * seconds);
  const velocityFactor = (1 - decay) / damping;
  const terminalVelocity = vScale(acceleration, 1 / damping);
  const velocity = vAdd(terminalVelocity, vScale(vSub(initialVelocity, terminalVelocity), decay));
  const displacement = vAdd(
    vScale(terminalVelocity, seconds),
    vScale(vSub(initialVelocity, terminalVelocity), velocityFactor),
  );
  return [displacement, velocity];
}

function dampedMotion(initial: Vec3, damping: number, seconds: number): [Vec3, Vec3] {
  if (damping <= EPSILON) {
    return [vScale(initial, seconds), vClone(initial)];
  }
  const decay = Math.exp(-damping * seconds);
  return [vScale(initial, (1 - decay) / damping), vScale(initial, decay)];
}

/**
 * One step of a critically damped spring toward zero, on the pair in place:
 * p' = (p + (v + pω)t)e^{-ωt}, v' = (v - (v + pω)ωt)e^{-ωt}.
 */
function criticalStepInPlace(position: Vec3, velocity: Vec3, omega: number, seconds: number, decay: number): void {
  const os = omega * seconds;
  for (let i = 0; i < 3; i += 1) {
    const offset = velocity[i] + position[i] * omega;
    position[i] = (position[i] + offset * seconds) * decay;
    velocity[i] = (velocity[i] - offset * os) * decay;
  }
}
