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
    // The world falls at 20 m/s^2 (matched to the player; see
    // VIBE_WORLD_GRAVITY) — 9.81 predates that change, and extrapolating
    // ballistic debris at half its real gravity is what made starved tracks
    // sag behind truth and need the upward correction in the first place.
    gravity: [0, -20.0, 0],
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
  state: PresentedState;
  revision: number;
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

export class PresentationTrack {
  private readonly config: PresentationConfig;
  private readonly linearDamping: number;
  private readonly angularDamping: number;
  private snapshots: MotionSnapshot[] = [];
  private correction: Correction = zeroCorrection();
  private previous: PreviousSample | null = null;
  private revision = 0;
  private onAnomaly: PresentationAnomalyListener | null = null;

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

  sample(renderTickInput: number): PresentedState {
    this.lastSampleSettled = false;
    if (this.snapshots.length === 0) {
      return defaultState();
    }
    const renderTick = Number.isFinite(renderTickInput) ? renderTickInput : 0;
    const targetTick = renderTick - this.config.interpolationDelayTicks;
    if (this.isSettled(renderTick, targetTick)) {
      this.lastSampleSettled = true;
      // Advance the clock but reuse the state: the revision re-anchor below
      // reads `previous.renderTick`, so letting it go stale would mis-anchor
      // the next correction. Nothing else in the record can have moved.
      this.previous!.renderTick = renderTick;
      return this.previous!.state;
    }
    const raw = this.rawState(targetTick);

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
        const revisedPrevious = this.rawState(
          this.previous.renderTick - this.config.interpolationDelayTicks,
        );
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
        if (correctionDistance > this.config.snapDistanceMeters) {
          this.onAnomaly?.({ kind: 'correction_snap', magnitude: correctionDistance });
          this.correction = zeroCorrection();
        } else {
          this.correction = correction;
        }
      }
    }

    this.decayCorrection(elapsedSeconds);

    const state: PresentedState = {
      position: vAdd(raw.position, this.correction.position),
      rotation: qNormalize(qMul(qFromScaledAxis(this.correction.rotation), raw.rotation)),
      linearVelocity: vAdd(raw.linearVelocity, this.correction.linearVelocity),
      angularVelocity: vAdd(raw.angularVelocity, this.correction.angularVelocity),
      positionCorrection: vClone(this.correction.position),
      rotationCorrectionDegrees: (vLength(this.correction.rotation) * 180) / Math.PI,
    };

    this.previous = { renderTick, state, revision: this.revision };
    this.prune(targetTick);
    return state;
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
          this.onAnomaly,
        );
      }
    }
    return this.extrapolate(this.snapshots[this.snapshots.length - 1], targetTick);
  }

  private extrapolate(snapshot: MotionSnapshot, targetTick: number): PresentedState {
    const extraTicks = Math.min(
      Math.max(0, targetTick - snapshot.tick),
      this.config.maxExtrapolationTicks,
    );
    const seconds = extraTicks * this.config.dt;

    if (snapshot.class === PresentationClass.Quiescent) {
      return {
        ...defaultState(),
        position: vClone(snapshot.position),
        rotation: snapshot.rotation,
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

    return {
      ...defaultState(),
      position: vAdd(snapshot.position, positionDelta),
      rotation: qNormalize(qMul(qFromScaledAxis(angularDelta), snapshot.rotation)),
      linearVelocity,
      angularVelocity,
    };
  }

  private decayCorrection(seconds: number): void {
    if (this.config.correctionSeconds <= EPSILON) {
      this.correction = zeroCorrection();
      return;
    }
    // Four time constants leaves ~9% of a critically damped zero-velocity
    // displacement after correctionSeconds.
    const omega = 4 / this.config.correctionSeconds;
    [this.correction.position, this.correction.linearVelocity] = criticalStep(
      this.correction.position,
      this.correction.linearVelocity,
      omega,
      seconds,
    );
    [this.correction.rotation, this.correction.angularVelocity] = criticalStep(
      this.correction.rotation,
      this.correction.angularVelocity,
      omega,
      seconds,
    );
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
      const frozenAt = last.tick + this.config.maxExtrapolationTicks;
      const previousTarget = previous.renderTick - this.config.interpolationDelayTicks;
      if (targetTick < frozenAt || previousTarget < frozenAt) return false;
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
    ...defaultState(),
    position: vClone(snapshot.position),
    rotation: snapshot.rotation,
    linearVelocity: vClone(snapshot.linearVelocity),
    angularVelocity: vClone(snapshot.angularVelocity),
  };
}

function interpolate(
  left: MotionSnapshot,
  right: MotionSnapshot,
  targetTick: number,
  dt: number,
  snapDistanceMeters: number,
  onAnomaly?: PresentationAnomalyListener | null,
): PresentedState {
  const tickSpan = right.tick - left.tick;
  if (tickSpan <= 0) {
    return snapshotState(right);
  }
  const seconds = tickSpan * dt;
  const plausibleMotion =
    Math.max(vLength(left.linearVelocity), vLength(right.linearVelocity)) * seconds;
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

  const position = vAdd(
    vAdd(vScale(left.position, h00), vScale(left.linearVelocity, h10 * seconds)),
    vAdd(vScale(right.position, h01), vScale(right.linearVelocity, h11 * seconds)),
  );

  const dh00 = 6 * u2 - 6 * u;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = -dh00;
  const dh11 = 3 * u2 - 2 * u;
  const linearVelocity = vScale(
    vAdd(
      vAdd(vScale(left.position, dh00), vScale(left.linearVelocity, dh10 * seconds)),
      vAdd(vScale(right.position, dh01), vScale(right.linearVelocity, dh11 * seconds)),
    ),
    1 / seconds,
  );

  return {
    ...defaultState(),
    position,
    rotation: qSlerp(left.rotation, right.rotation, u),
    linearVelocity,
    angularVelocity: vLerp(left.angularVelocity, right.angularVelocity, u),
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

function criticalStep(position: Vec3, velocity: Vec3, omega: number, seconds: number): [Vec3, Vec3] {
  if (seconds <= 0) {
    return [position, velocity];
  }
  const offset = vAdd(velocity, vScale(position, omega));
  const decay = Math.exp(-omega * seconds);
  return [
    vScale(vAdd(position, vScale(offset, seconds)), decay),
    vScale(vSub(velocity, vScale(offset, omega * seconds)), decay),
  ];
}
