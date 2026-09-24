import { TsServerClock, type ServerClockModel } from './serverClockModel';

export type PlayerSample = {
  serverTimeUs: number;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
  flags: number;
};

export type VehicleSample = {
  serverTimeUs: number;
  position: [number, number, number];
  quaternion: [number, number, number, number]; // x, y, z, w
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  wheelData: [number, number, number, number];
  driverPlayerId: number;
  flags: number;
};

export type DynamicBodySample = {
  serverTimeUs: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  halfExtents: [number, number, number];
  velocity: [number, number, number];
  angularVelocity: [number, number, number];
  shapeType: number;
};

const MAX_PLAYER_EXTRAPOLATION_US = 100_000;

export class VehicleInterpolator {
  private readonly byEntity = new Map<number, VehicleSample[]>();

  constructor(private readonly maxSamples = 32) {}

  push(entityId: number, sample: VehicleSample): void {
    const queue = this.byEntity.get(entityId) ?? [];
    queue.push(sample);
    queue.sort((a, b) => a.serverTimeUs - b.serverTimeUs);
    while (queue.length > this.maxSamples) {
      queue.shift();
    }
    this.byEntity.set(entityId, queue);
  }

  remove(entityId: number): void {
    this.byEntity.delete(entityId);
  }

  retainOnly(activeIds: Set<number>): void {
    for (const id of this.byEntity.keys()) {
      if (!activeIds.has(id)) {
        this.byEntity.delete(id);
      }
    }
  }

  ids(): number[] {
    return [...this.byEntity.keys()];
  }

  sample(entityId: number, targetTimeUs: number): VehicleSample | null {
    const queue = this.byEntity.get(entityId);
    if (!queue || queue.length === 0) return null;
    if (queue.length === 1 || targetTimeUs <= queue[0].serverTimeUs) {
      return { ...queue[0] };
    }

    for (let i = 1; i < queue.length; i += 1) {
      const prev = queue[i - 1];
      const next = queue[i];
      if (targetTimeUs <= next.serverTimeUs) {
        if (next.serverTimeUs === prev.serverTimeUs) return { ...next };
        const alpha = clamp01((targetTimeUs - prev.serverTimeUs) / (next.serverTimeUs - prev.serverTimeUs));
        return {
          serverTimeUs: targetTimeUs,
          position: lerpVec3(prev.position, next.position, alpha),
          quaternion: slerpQuat(prev.quaternion, next.quaternion, alpha),
          linearVelocity: lerpVec3(prev.linearVelocity, next.linearVelocity, alpha),
          angularVelocity: lerpVec3(prev.angularVelocity, next.angularVelocity, alpha),
          wheelData: alpha < 0.5 ? prev.wheelData : next.wheelData,
          driverPlayerId: alpha < 0.5 ? prev.driverPlayerId : next.driverPlayerId,
          flags: alpha < 0.5 ? prev.flags : next.flags,
        };
      }
    }

    // Extrapolate: buffer has run dry — use velocity to predict ahead
    const latest = queue[queue.length - 1];
    const maxExtrapolateSecs = 0.250;
    const extrapolateSecs = Math.min(
      (targetTimeUs - latest.serverTimeUs) / 1_000_000,
      maxExtrapolateSecs,
    );
    if (extrapolateSecs <= 0) return { ...latest };

    const lv = latest.linearVelocity;
    const av = latest.angularVelocity;
    const pos: [number, number, number] = [
      latest.position[0] + lv[0] * extrapolateSecs,
      latest.position[1] + lv[1] * extrapolateSecs,
      latest.position[2] + lv[2] * extrapolateSecs,
    ];

    // Integrate angular velocity into quaternion
    const angSpeed = Math.sqrt(av[0] * av[0] + av[1] * av[1] + av[2] * av[2]);
    let quat = latest.quaternion;
    if (angSpeed > 0.0001) {
      const angle = angSpeed * extrapolateSecs;
      const ax = av[0] / angSpeed;
      const ay = av[1] / angSpeed;
      const az = av[2] / angSpeed;
      const s = Math.sin(angle / 2);
      const dq: [number, number, number, number] = [ax * s, ay * s, az * s, Math.cos(angle / 2)];
      // quat = dq * quat
      const [qx, qy, qz, qw] = quat;
      const [dx, dy, dz, dw] = dq;
      quat = [
        dw * qx + dx * qw + dy * qz - dz * qy,
        dw * qy - dx * qz + dy * qw + dz * qx,
        dw * qz + dx * qy - dy * qx + dz * qw,
        dw * qw - dx * qx - dy * qy - dz * qz,
      ];
    }
    return { ...latest, position: pos, quaternion: quat };
  }
}

export class DynamicBodyInterpolator {
  private readonly byEntity = new Map<number, DynamicBodySample[]>();

  constructor(private readonly maxSamples = 32) {}

  push(entityId: number, sample: DynamicBodySample): void {
    const queue = this.byEntity.get(entityId) ?? [];
    queue.push(sample);
    queue.sort((a, b) => a.serverTimeUs - b.serverTimeUs);
    while (queue.length > this.maxSamples) {
      queue.shift();
    }
    this.byEntity.set(entityId, queue);
  }

  remove(entityId: number): void {
    this.byEntity.delete(entityId);
  }

  retainOnly(activeIds: Set<number>): void {
    for (const id of this.byEntity.keys()) {
      if (!activeIds.has(id)) {
        this.byEntity.delete(id);
      }
    }
  }

  sample(entityId: number, targetTimeUs: number): DynamicBodySample | null {
    const queue = this.byEntity.get(entityId);
    if (!queue || queue.length === 0) return null;
    return sampleDynamicBodyTrack(queue, targetTimeUs);
  }

  /** The buffered snapshots of one body, oldest first (empty if none). */
  samples(entityId: number): readonly DynamicBodySample[] {
    return this.byEntity.get(entityId) ?? EMPTY_DYNAMIC_SAMPLES;
  }
}

const EMPTY_DYNAMIC_SAMPLES: readonly DynamicBodySample[] = [];
const MAX_DYNAMIC_BODY_EXTRAPOLATION_S = 0.25;

/**
 * A dynamic body's state at `targetTimeUs` from its snapshots (oldest first):
 * interpolated between the two around it, the oldest before them, and
 * extrapolated past the newest for at most 250 ms.
 *
 * The extrapolation is ballistic when the last two snapshots show the body in
 * free fall -- vertical acceleration between 0.5 and 3 g downwards with
 * horizontal velocity unchanged, as a thrown cannonball or falling debris is --
 * and linear otherwise. Linear extrapolation of a falling body runs above its
 * arc and then snaps down; gravity applied to a body resting on the ground
 * would sink it, which is why the test is on the measured acceleration rather
 * than on the body being airborne.
 */
export function sampleDynamicBodyTrack(
  queue: readonly DynamicBodySample[],
  targetTimeUs: number,
): DynamicBodySample | null {
  if (queue.length === 0) return null;
  if (queue.length === 1 || targetTimeUs <= queue[0].serverTimeUs) {
    return { ...queue[0] };
  }

  for (let i = 1; i < queue.length; i += 1) {
    const prev = queue[i - 1];
    const next = queue[i];
    if (targetTimeUs <= next.serverTimeUs) {
      if (next.serverTimeUs === prev.serverTimeUs) return { ...next };
      const alpha = clamp01((targetTimeUs - prev.serverTimeUs) / (next.serverTimeUs - prev.serverTimeUs));
      return {
        serverTimeUs: targetTimeUs,
        position: lerpVec3(prev.position, next.position, alpha),
        quaternion: slerpQuat(prev.quaternion, next.quaternion, alpha),
        halfExtents: alpha < 0.5 ? prev.halfExtents : next.halfExtents,
        velocity: lerpVec3(prev.velocity, next.velocity, alpha),
        angularVelocity: lerpVec3(prev.angularVelocity, next.angularVelocity, alpha),
        shapeType: alpha < 0.5 ? prev.shapeType : next.shapeType,
      };
    }
  }

  const latest = queue[queue.length - 1];
  const extrapolateSecs = Math.min(
    (targetTimeUs - latest.serverTimeUs) / 1_000_000,
    MAX_DYNAMIC_BODY_EXTRAPOLATION_S,
  );
  if (extrapolateSecs <= 0) return { ...latest };

  const lv = latest.velocity;
  const av = latest.angularVelocity;
  const fallAccel = freeFallAcceleration(queue[queue.length - 2], latest);
  const t = extrapolateSecs;
  const position: [number, number, number] = [
    latest.position[0] + lv[0] * t,
    latest.position[1] + lv[1] * t + 0.5 * fallAccel * t * t,
    latest.position[2] + lv[2] * t,
  ];
  const velocity: [number, number, number] = [lv[0], lv[1] + fallAccel * t, lv[2]];
  return { ...latest, position, velocity, quaternion: integrateAngularVelocity(latest.quaternion, av, t) };
}

const STANDARD_GRAVITY = 9.81;

/**
 * The vertical acceleration (m/s^2, negative) between two snapshots of a body
 * in free fall, or 0 when the pair does not look like free fall.
 */
export function freeFallAcceleration(prev: DynamicBodySample, next: DynamicBodySample): number {
  const dt = (next.serverTimeUs - prev.serverTimeUs) / 1_000_000;
  if (dt <= 0 || dt > 0.25) return 0;
  const ay = (next.velocity[1] - prev.velocity[1]) / dt;
  if (ay > -0.5 * STANDARD_GRAVITY || ay < -3 * STANDARD_GRAVITY) return 0;
  const horizontalChange = Math.hypot(next.velocity[0] - prev.velocity[0], next.velocity[2] - prev.velocity[2]) / dt;
  if (horizontalChange > 0.25 * Math.abs(ay)) return 0;
  return ay;
}

/** `quat` turned by angular velocity `av` (rad/s) for `t` seconds. */
export function integrateAngularVelocity(
  quat: [number, number, number, number],
  av: [number, number, number],
  t: number,
): [number, number, number, number] {
  const angSpeed = Math.sqrt(av[0] * av[0] + av[1] * av[1] + av[2] * av[2]);
  if (angSpeed <= 0.0001) return quat;
  const angle = angSpeed * t;
  const ax = av[0] / angSpeed;
  const ay = av[1] / angSpeed;
  const az = av[2] / angSpeed;
  const sn = Math.sin(angle / 2);
  const [dx, dy, dz, dw] = [ax * sn, ay * sn, az * sn, Math.cos(angle / 2)];
  const [qx, qy, qz, qw] = quat;
  return [
    dw * qx + dx * qw + dy * qz - dz * qy,
    dw * qy - dx * qz + dy * qw + dz * qx,
    dw * qz + dx * qy - dy * qx + dz * qw,
    dw * qw - dx * qx - dy * qy - dz * qz,
  ];
}

export type ProjectileSample = {
  serverTimeUs: number;
  position: [number, number, number];
  velocity: [number, number, number];
  kind: number;
  ownerId: number;
  sourceShotId: number;
};

// Registered by sharedPhysics.ts after WASM init: the live client runs the
// estimator from netcode/src/clock_sync.rs. Without it (tests, the offline tape
// tools) the TypeScript copy in serverClockModel.ts runs, which is kept equal.
let _WasmClockSyncClass: ((simHz: number) => ServerClockModel) | null = null;

/**
 * Register the WASM WasmClockSync constructor.
 * Called once by sharedPhysics after `init()` resolves.
 */
export function provideWasmClockSync(cls: new (simHz: number) => ServerClockModel): void {
  _WasmClockSyncClass = (simHz) => new cls(simHz);
}

/**
 * The client's estimate of server simulation time.
 *
 * Server time on the wire is `tick x 16.67 ms`; when the server cannot hold
 * 60 Hz it advances slower than wall time. The model underneath
 * (clock_sync.rs, or serverClockModel.ts without WASM) measures that rate,
 * follows it without ever stepping backwards, and sizes the interpolation
 * delay from snapshot arrivals. `serverNowUs` advances that model, so it is
 * called with the client's own clock; `getOffsetUs` only reads it.
 */
export class ServerClockEstimator {
  private model: ServerClockModel | null = null;
  private simHz = 60;
  private pendingRttMs: number[] = [];

  private getModel(): ServerClockModel {
    if (!this.model) {
      this.model = _WasmClockSyncClass ? _WasmClockSyncClass(this.simHz) : new TsServerClock(this.simHz);
      for (const rtt of this.pendingRttMs) this.model.observeRtt(rtt);
      this.pendingRttMs = [];
    }
    return this.model;
  }

  /** Whether the WASM (live) estimator is in use rather than the TypeScript copy. */
  get usesWasm(): boolean {
    return !(this.getModel() instanceof TsServerClock);
  }

  /** Set the server sim tick rate. Restarts the estimator when it changes. */
  setSimHz(hz: number): void {
    if (this.simHz === hz) return;
    this.simHz = hz;
    if (this.model) {
      this.model.free();
      this.model = null;
    }
  }

  /** Feed a smoothed RTT measurement in milliseconds. */
  observeRtt(rttMs: number): void {
    this.getModel().observeRtt(rttMs);
  }

  /**
   * A snapshot's server time, observed at local time `localTimeUs`. With
   * `serverWallUs` (the server's wall clock, us mod 2^32, when the snapshot
   * carries it) the server rate is measured exactly rather than inferred
   * from arrival times.
   */
  observe(serverTimeUs: number, localTimeUs: number, serverWallUs?: number | null): void {
    if (serverWallUs != null) {
      this.getModel().observeServerTimeWithWall(serverTimeUs, serverWallUs, localTimeUs);
    } else {
      this.getModel().observeServerTime(serverTimeUs, localTimeUs);
    }
  }

  /** Estimated server time at `localTimeUs`; never decreases as local time advances. */
  serverNowUs(localTimeUs = performance.now() * 1000): number {
    return Math.round(this.getModel().serverNowUs(localTimeUs));
  }

  /**
   * `serverNowUs - interpolationDelayUs`. Monotonic only while the delay is
   * steady: `RenderClock` is the render time that stays monotonic while the
   * delay adapts.
   */
  renderTimeUs(interpolationDelayUs: number, localTimeUs = performance.now() * 1000): number {
    return this.serverNowUs(localTimeUs) - interpolationDelayUs;
  }

  /** server time ~ local time + offset, as of the last `serverNowUs`. Read-only. */
  getOffsetUs(): number {
    return this.model?.getClockOffsetUs() ?? 0;
  }

  /** Measured server rate: sim seconds per wall second (1 until measured). */
  getRate(): number {
    return this.model?.getRate() ?? 1;
  }

  /** Whether the server stamps its wall clock on the snapshots in use. */
  hasServerWallClock(): boolean {
    return this.model?.hasWallClock() ?? false;
  }

  /** Jitter estimate in microseconds (from round trips; 0 on WebTransport). */
  getJitterUs(): number {
    return this.model?.getJitterUs() ?? 0;
  }

  /**
   * Recommended interpolation delay, ms of server time: the 95th percentile of
   * server time that elapses between snapshot arrivals, never less than one
   * observed snapshot interval, at most 250 ms. 0 before any snapshot.
   */
  getInterpolationDelayMs(): number {
    return this.model ? this.model.getInterpolationDelayMs() : 0;
  }

  /** Median server-time step between snapshots, ms. */
  getSnapshotIntervalMs(): number {
    return this.model?.getSnapshotIntervalMs() ?? 1000 / this.simHz;
  }
}

/**
 * A render time that never goes backwards: the server clock minus an
 * interpolation delay that adapts only as fast as the clock advances.
 *
 * `serverNow - delay` goes backwards whenever the delay grows faster than the
 * clock -- and the clock stops altogether while the server stalls. So the
 * delay moves towards its target by at most `DELAY_SLEW` of each step the
 * clock takes, and the result is clamped to never fall below the last render
 * time handed out. A local clock that jumps back by more than a second (a
 * replay seek) starts over.
 */
export class RenderClock {
  /** Growing delay may take up to this share of each clock step (render slows, to a stop at 1). */
  static DELAY_GROW_SLEW = 0.25;
  /** Shrinking delay may add up to this share of each clock step (render speeds up by at most this). */
  static readonly DELAY_SLEW = 0.25;
  private delayUs: number | null = null;
  private targetDelayUs = 0;
  private lastServerNowUs = 0;
  private lastRenderUs = -Infinity;
  private lastLocalUs = -Infinity;

  setTargetDelayMs(ms: number): void {
    this.targetDelayUs = Math.max(0, ms * 1000);
    if (this.delayUs === null) this.delayUs = this.targetDelayUs;
  }

  /**
   * A new target delay as of (`serverNowUs`, `localTimeUs`): the clock is
   * first advanced to that instant under the old target. The delay slews by a
   * share of each step of server time, so with retargets committed where they
   * happen the render time does not depend on how often it is read.
   */
  retarget(ms: number, serverNowUs: number, localTimeUs: number): void {
    if (this.lastRenderUs !== -Infinity && localTimeUs >= this.lastLocalUs - 1_000_000) {
      this.renderTimeUs(serverNowUs, localTimeUs);
    }
    this.setTargetDelayMs(ms);
  }

  /** The delay the clock is moving towards, ms. */
  get targetDelayMs(): number {
    return this.targetDelayUs / 1000;
  }

  /** The delay in use, ms (what the render time is behind server time). */
  get delayMs(): number {
    return (this.delayUs ?? this.targetDelayUs) / 1000;
  }

  renderTimeUs(serverNowUs: number, localTimeUs: number): number {
    if (this.delayUs === null) this.delayUs = this.targetDelayUs;
    if (localTimeUs < this.lastLocalUs - 1_000_000) this.reset();
    if (this.lastRenderUs === -Infinity) {
      this.lastServerNowUs = serverNowUs;
      this.delayUs = this.targetDelayUs;
    } else {
      const advanced = Math.max(0, serverNowUs - this.lastServerNowUs);
      const delta = this.targetDelayUs - this.delayUs;
      this.delayUs += delta > 0
        ? Math.min(delta, advanced * RenderClock.DELAY_GROW_SLEW)
        : Math.max(delta, -advanced * RenderClock.DELAY_SLEW);
      this.lastServerNowUs = Math.max(this.lastServerNowUs, serverNowUs);
    }
    const render = Math.max(this.lastRenderUs, serverNowUs - this.delayUs);
    this.lastRenderUs = render;
    this.lastLocalUs = Math.max(this.lastLocalUs, localTimeUs);
    return render;
  }

  reset(): void {
    this.delayUs = this.targetDelayUs;
    this.lastServerNowUs = 0;
    this.lastRenderUs = -Infinity;
    this.lastLocalUs = -Infinity;
  }
}

export class PlayerInterpolator {
  private readonly byEntity = new Map<number, PlayerSample[]>();

  constructor(private readonly maxSamples = 32) {}

  push(entityId: number, sample: PlayerSample): void {
    const queue = this.byEntity.get(entityId) ?? [];
    queue.push(sample);
    queue.sort((a, b) => a.serverTimeUs - b.serverTimeUs);
    while (queue.length > this.maxSamples) {
      queue.shift();
    }
    this.byEntity.set(entityId, queue);
  }

  remove(entityId: number): void {
    this.byEntity.delete(entityId);
  }

  retainOnly(activeIds: Set<number>): void {
    for (const id of this.byEntity.keys()) {
      if (!activeIds.has(id)) {
        this.byEntity.delete(id);
      }
    }
  }

  ids(): number[] {
    return [...this.byEntity.keys()];
  }

  sample(entityId: number, targetTimeUs: number): PlayerSample | null {
    const queue = this.byEntity.get(entityId);
    if (!queue || queue.length === 0) {
      return null;
    }
    if (queue.length === 1 || targetTimeUs <= queue[0].serverTimeUs) {
      return { ...queue[0] };
    }

    for (let i = 1; i < queue.length; i += 1) {
      const prev = queue[i - 1];
      const next = queue[i];
      if (targetTimeUs <= next.serverTimeUs) {
        if (next.serverTimeUs === prev.serverTimeUs) {
          return { ...next };
        }
        const alpha = clamp01((targetTimeUs - prev.serverTimeUs) / (next.serverTimeUs - prev.serverTimeUs));
        return {
          serverTimeUs: targetTimeUs,
          position: lerpVec3(prev.position, next.position, alpha),
          velocity: lerpVec3(prev.velocity, next.velocity, alpha),
          yaw: lerpAngle(prev.yaw, next.yaw, alpha),
          pitch: lerpAngle(prev.pitch, next.pitch, alpha),
          hp: alpha < 0.5 ? prev.hp : next.hp,
          flags: alpha < 0.5 ? prev.flags : next.flags,
        };
      }
    }
    const latest = queue[queue.length - 1];
    const extrapolateUs = Math.min(targetTimeUs - latest.serverTimeUs, MAX_PLAYER_EXTRAPOLATION_US);
    if (extrapolateUs <= 0) {
      return { ...latest };
    }
    const extrapolateSecs = extrapolateUs / 1_000_000;
    return {
      ...latest,
      position: [
        latest.position[0] + latest.velocity[0] * extrapolateSecs,
        latest.position[1] + latest.velocity[1] * extrapolateSecs,
        latest.position[2] + latest.velocity[2] * extrapolateSecs,
      ],
    };
  }
}

const MAX_PROJECTILE_EXTRAPOLATION_US = 150_000;

export class ProjectileInterpolator {
  private readonly byEntity = new Map<number, ProjectileSample[]>();

  constructor(private readonly maxSamples = 32) {}

  push(entityId: number, sample: ProjectileSample): void {
    const queue = this.byEntity.get(entityId) ?? [];
    queue.push(sample);
    queue.sort((a, b) => a.serverTimeUs - b.serverTimeUs);
    while (queue.length > this.maxSamples) {
      queue.shift();
    }
    this.byEntity.set(entityId, queue);
  }

  remove(entityId: number): void {
    this.byEntity.delete(entityId);
  }

  retainOnly(activeIds: Set<number>): void {
    for (const id of this.byEntity.keys()) {
      if (!activeIds.has(id)) {
        this.byEntity.delete(id);
      }
    }
  }

  ids(): number[] {
    return [...this.byEntity.keys()];
  }

  sample(entityId: number, targetTimeUs: number): ProjectileSample | null {
    const queue = this.byEntity.get(entityId);
    if (!queue || queue.length === 0) {
      return null;
    }
    if (queue.length === 1 || targetTimeUs <= queue[0].serverTimeUs) {
      return { ...queue[0] };
    }

    for (let i = 1; i < queue.length; i += 1) {
      const prev = queue[i - 1];
      const next = queue[i];
      if (targetTimeUs <= next.serverTimeUs) {
        if (next.serverTimeUs === prev.serverTimeUs) {
          return { ...next };
        }
        const alpha = clamp01((targetTimeUs - prev.serverTimeUs) / (next.serverTimeUs - prev.serverTimeUs));
        return {
          serverTimeUs: targetTimeUs,
          position: lerpVec3(prev.position, next.position, alpha),
          velocity: lerpVec3(prev.velocity, next.velocity, alpha),
          kind: alpha < 0.5 ? prev.kind : next.kind,
          ownerId: alpha < 0.5 ? prev.ownerId : next.ownerId,
          sourceShotId: alpha < 0.5 ? prev.sourceShotId : next.sourceShotId,
        };
      }
    }

    const latest = queue[queue.length - 1];
    if (targetTimeUs <= latest.serverTimeUs) {
      return { ...latest };
    }

    const extrapolateUs = Math.min(MAX_PROJECTILE_EXTRAPOLATION_US, targetTimeUs - latest.serverTimeUs);
    const dt = extrapolateUs / 1_000_000;
    return {
      serverTimeUs: latest.serverTimeUs + extrapolateUs,
      position: [
        latest.position[0] + latest.velocity[0] * dt,
        latest.position[1] + latest.velocity[1] * dt,
        latest.position[2] + latest.velocity[2] * dt,
      ],
      velocity: [...latest.velocity] as [number, number, number],
      kind: latest.kind,
      ownerId: latest.ownerId,
      sourceShotId: latest.sourceShotId,
    };
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
  ];
}

export type SnapshotSample = {
  serverTick: number;
  receivedAtMs: number;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
  flags: number;
};

export class SnapshotInterpolator {
  private readonly byEntity = new Map<number, SnapshotSample[]>();
  private readonly maxSamples: number;

  constructor(maxSamples = 32) {
    this.maxSamples = maxSamples;
  }

  push(entityId: number, sample: SnapshotSample): void {
    const queue = this.byEntity.get(entityId) ?? [];
    queue.push(sample);
    while (queue.length > this.maxSamples) {
      queue.shift();
    }
    this.byEntity.set(entityId, queue);
  }

  remove(entityId: number): void {
    this.byEntity.delete(entityId);
  }

  sample(entityId: number, renderTimeMs: number): SnapshotSample | null {
    const queue = this.byEntity.get(entityId);
    if (!queue || queue.length === 0) return null;
    if (queue.length === 1) return { ...queue[0] };

    for (let i = 1; i < queue.length; i++) {
      const prev = queue[i - 1];
      const next = queue[i];
      if (renderTimeMs <= next.receivedAtMs) {
        const alpha = clamp01(
          (renderTimeMs - prev.receivedAtMs) / (next.receivedAtMs - prev.receivedAtMs || 1),
        );
        return {
          serverTick: alpha < 0.5 ? prev.serverTick : next.serverTick,
          receivedAtMs: renderTimeMs,
          position: lerpVec3(prev.position, next.position, alpha),
          velocity: lerpVec3(prev.velocity, next.velocity, alpha),
          yaw: lerpAngle(prev.yaw, next.yaw, alpha),
          pitch: lerpAngle(prev.pitch, next.pitch, alpha),
          hp: alpha < 0.5 ? prev.hp : next.hp,
          flags: alpha < 0.5 ? prev.flags : next.flags,
        };
      }
    }

    return { ...queue[queue.length - 1] };
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function slerpQuat(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  // dot product to find angle between quaternions
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  // flip b if dot < 0 to take shortest path
  const bx = dot < 0 ? -b[0] : b[0];
  const by = dot < 0 ? -b[1] : b[1];
  const bz = dot < 0 ? -b[2] : b[2];
  const bw = dot < 0 ? -b[3] : b[3];
  dot = Math.abs(dot);

  // Use lerp for nearly identical quaternions to avoid NaN from acos
  if (dot > 0.9995) {
    const inv = 1 - t;
    const rx = inv * a[0] + t * bx;
    const ry = inv * a[1] + t * by;
    const rz = inv * a[2] + t * bz;
    const rw = inv * a[3] + t * bw;
    const len = Math.hypot(rx, ry, rz, rw) || 1;
    return [rx / len, ry / len, rz / len, rw / len];
  }

  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s1 = Math.cos(theta) - dot * sinTheta / sinTheta0;
  const s2 = sinTheta / sinTheta0;
  return [
    s1 * a[0] + s2 * bx,
    s1 * a[1] + s2 * by,
    s1 * a[2] + s2 * bz,
    s1 * a[3] + s2 * bw,
  ];
}
