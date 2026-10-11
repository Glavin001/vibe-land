import type { DetachedPart } from './vehicleStream';

type V3 = [number, number, number];
type Q = [number, number, number, number];

/** The per-player core's correction blend (perplayer/src/client.rs `CORRECTION_TICKS`), at 60 Hz. */
export const DETACH_BLEND_MS = (9 * 1000) / 60;

const smoothstep = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

const mul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
/** slerp(identity, q, w), taking the short way. */
const partial = (q: Q, w: number): Q => {
  const s = q[3] < 0 ? -1 : 1;
  const [x, y, z, qw] = [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
  const angle = 2 * Math.acos(Math.min(1, qw));
  const sin = Math.sqrt(x * x + y * y + z * z);
  if (sin < 1e-9) return [0, 0, 0, 1];
  const h = 0.5 * angle * w;
  const k = Math.sin(h) / sin;
  return [x * k, y * k, z * k, Math.cos(h)];
};

/**
 * Parts leaving the car the player drives. That car is drawn ahead of the
 * server (its prediction), its loose parts on the car clock behind it, so a
 * part would jump back by its speed times the gap the moment it leaves.
 * Instead it starts where it was drawn on the car and blends onto its own
 * track as the core blends a late keyframe in (DETACH_BLEND_MS).
 */
export class DetachBlend {
  private readonly blends = new Map<number, { offset: V3; turn: Q; fromMs: number }>();
  private loose = new Set<number>();

  /** `car`: the driven car's drawn pose this frame (the frame its parts map from). */
  apply(nowMs: number, car: { position: V3; quaternion: Q } | null, parts: DetachedPart[]): DetachedPart[] {
    const loose = new Set<number>();
    const out: DetachedPart[] = [];
    for (const part of parts) {
      loose.add(part.part);
      if (!this.loose.has(part.part) && car) {
        this.blends.set(part.part, {
          offset: [car.position[0] - part.position[0], car.position[1] - part.position[1], car.position[2] - part.position[2]],
          turn: mul(car.quaternion, conj(part.rotation)),
          fromMs: nowMs,
        });
      }
      const blend = this.blends.get(part.part);
      const w = blend ? 1 - smoothstep((nowMs - blend.fromMs) / DETACH_BLEND_MS) : 0;
      if (!blend || w <= 0) {
        if (blend) this.blends.delete(part.part);
        out.push(part);
        continue;
      }
      out.push({
        part: part.part,
        position: [part.position[0] + blend.offset[0] * w, part.position[1] + blend.offset[1] * w, part.position[2] + blend.offset[2] * w],
        rotation: mul(partial(blend.turn, w), part.rotation),
      });
    }
    for (const part of this.blends.keys()) if (!loose.has(part)) this.blends.delete(part);
    this.loose = loose;
    return out;
  }

  reset(): void {
    this.blends.clear();
    this.loose.clear();
  }
}
