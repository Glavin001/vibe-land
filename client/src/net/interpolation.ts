export type PlayerSample = {
  serverTimeUs: number;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  flags: number;
};

export type ProjectileSample = {
  serverTimeUs: number;
  position: [number, number, number];
  velocity: [number, number, number];
  kind: number;
  ownerId: number;
  sourceShotId: number;
};

export class ServerClockEstimator {
  private offsetUs = 0;
  private initialized = false;

  /**
   * Update the estimated clock offset from a new server→client sample.
   *
   * The offset is `serverTime − localTime`.  A packet that arrives with
   * lower one-way delay produces a *higher* offset, so the best estimate
   * of the true offset is the *maximum* observed sample (minus jitter).
   *
   * Previous implementation used a monotonic ratchet (always jump up,
   * slowly drift down at 2%).  This caused unbounded growth over long
   * sessions because any transient jitter spike permanently ratcheted
   * the offset up, and the 2% decay was too slow to compensate before
   * the next spike.
   *
   * New approach: symmetric EMA with a 10% weight on new samples.
   * This converges in ~10 samples (~0.3 s at 30 Hz snapshot rate)
   * instead of ~50, and doesn't ratchet.
   */
  observe(serverTimeUs: number, localTimeUs: number): void {
    const sampleOffsetUs = serverTimeUs - localTimeUs;
    if (!this.initialized) {
      this.offsetUs = sampleOffsetUs;
      this.initialized = true;
      return;
    }

    // Symmetric EMA — converges in both directions at the same rate.
    // α = 0.1 gives a half-life of ~7 samples ≈ 0.23 s at 30 Hz.
    this.offsetUs = this.offsetUs * 0.9 + sampleOffsetUs * 0.1;
  }

  serverNowUs(localTimeUs = performance.now() * 1000): number {
    return Math.round(localTimeUs + this.offsetUs);
  }

  renderTimeUs(interpolationDelayUs: number, localTimeUs = performance.now() * 1000): number {
    return this.serverNowUs(localTimeUs) - interpolationDelayUs;
  }

  getOffsetUs(): number {
    return this.offsetUs;
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
          flags: alpha < 0.5 ? prev.flags : next.flags,
        };
      }
    }

    return { ...queue[queue.length - 1] };
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
