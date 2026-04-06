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

  observe(serverTimeUs: number, localTimeUs: number): void {
    const sampleOffsetUs = serverTimeUs - localTimeUs;
    if (!this.initialized) {
      this.offsetUs = sampleOffsetUs;
      this.initialized = true;
      return;
    }

    if (sampleOffsetUs > this.offsetUs) {
      this.offsetUs = sampleOffsetUs;
      return;
    }

    this.offsetUs = this.offsetUs * 0.98 + sampleOffsetUs * 0.02;
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

function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}
