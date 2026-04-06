export type SampledPose = {
  serverTick: number;
  receivedAtMs: number;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  hp: number;
  flags: number;
};

export type InterpolatedPose = Omit<SampledPose, 'receivedAtMs'>;

export class SnapshotInterpolator {
  private readonly maxSamples: number;
  private readonly samplesByEntity = new Map<number, SampledPose[]>();

  constructor(maxSamples = 32) {
    this.maxSamples = maxSamples;
  }

  push(entityId: number, sample: SampledPose): void {
    const queue = this.samplesByEntity.get(entityId) ?? [];
    queue.push(sample);
    queue.sort((a, b) => a.serverTick - b.serverTick);
    while (queue.length > this.maxSamples) {
      queue.shift();
    }
    this.samplesByEntity.set(entityId, queue);
  }

  remove(entityId: number): void {
    this.samplesByEntity.delete(entityId);
  }

  sample(entityId: number, renderServerTick: number): InterpolatedPose | null {
    const queue = this.samplesByEntity.get(entityId);
    if (!queue || queue.length === 0) {
      return null;
    }

    if (queue.length === 1 || renderServerTick <= queue[0].serverTick) {
      return stripReceivedAt(queue[0]);
    }

    for (let i = 1; i < queue.length; i += 1) {
      const prev = queue[i - 1];
      const next = queue[i];
      if (renderServerTick <= next.serverTick) {
        const span = Math.max(1, next.serverTick - prev.serverTick);
        const t = clamp((renderServerTick - prev.serverTick) / span, 0, 1);
        return {
          serverTick: next.serverTick,
          position: lerp3(prev.position, next.position, t),
          velocity: lerp3(prev.velocity, next.velocity, t),
          yaw: lerpAngle(prev.yaw, next.yaw, t),
          pitch: lerpAngle(prev.pitch, next.pitch, t),
          hp: t < 0.5 ? prev.hp : next.hp,
          flags: t < 0.5 ? prev.flags : next.flags,
        };
      }
    }

    // Snapshot loss fallback: very short extrapolation using last known velocity.
    const latest = queue[queue.length - 1];
    const ticksAhead = Math.min(renderServerTick - latest.serverTick, 2);
    const dt = ticksAhead / 60;
    return {
      serverTick: latest.serverTick,
      position: [
        latest.position[0] + latest.velocity[0] * dt,
        latest.position[1] + latest.velocity[1] * dt,
        latest.position[2] + latest.velocity[2] * dt,
      ],
      velocity: latest.velocity,
      yaw: latest.yaw,
      pitch: latest.pitch,
      hp: latest.hp,
      flags: latest.flags,
    };
  }
}

function stripReceivedAt(sample: SampledPose): InterpolatedPose {
  return {
    serverTick: sample.serverTick,
    position: sample.position,
    velocity: sample.velocity,
    yaw: sample.yaw,
    pitch: sample.pitch,
    hp: sample.hp,
    flags: sample.flags,
  };
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
