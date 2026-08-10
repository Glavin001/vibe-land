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
  qToRotationVector,
  vAdd,
  vClone,
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
    correctionSeconds: 0.1,
    dt: 1 / 60,
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
  state: PresentedState;
  revision: number;
}

export class PresentationTrack {
  private readonly config: PresentationConfig;
  private readonly linearDamping: number;
  private readonly angularDamping: number;
  private snapshots: MotionSnapshot[] = [];
  private correction: Correction = zeroCorrection();
  private previous: PreviousSample | null = null;
  private revision = 0;

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

  /** Samples the track at a fractional render tick. */
  sample(renderTickInput: number): PresentedState {
    if (this.snapshots.length === 0) {
      return defaultState();
    }
    const renderTick = Number.isFinite(renderTickInput) ? renderTickInput : 0;
    const targetTick = renderTick - this.config.interpolationDelayTicks;
    const raw = this.rawState(targetTick);

    const elapsedSeconds = this.previous
      ? Math.max(0, renderTick - this.previous.renderTick) * this.config.dt
      : 0;

    if (this.previous) {
      if (renderTick < this.previous.renderTick) {
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
        this.correction =
          vLength(correction.position) > this.config.snapDistanceMeters
            ? zeroCorrection()
            : correction;
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
): PresentedState {
  const tickSpan = right.tick - left.tick;
  if (tickSpan <= 0) {
    return snapshotState(right);
  }
  const seconds = tickSpan * dt;
  const plausibleMotion =
    Math.max(vLength(left.linearVelocity), vLength(right.linearVelocity)) * seconds;
  if (vDistance(left.position, right.position) > plausibleMotion + snapDistanceMeters) {
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
