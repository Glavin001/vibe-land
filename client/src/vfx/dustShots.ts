// Shots the dust knows about, so the first break a shot causes reads as an
// entry: a spall puff on the near face, thrown back toward the shooter,
// rather than the same puff a load failure deep in the structure gets.
//
// Registered from the local fire path (the player's own shot, before the
// server has said anything) and from the server's shot-fired packet (other
// players). Matched by the fracture extractor: a cluster within the shot's
// corridor, in a cell that had been quiet, is that shot's entry.

export interface DustShot {
  ox: number;
  oy: number;
  oz: number;
  /** Unit direction. */
  dx: number;
  dy: number;
  dz: number;
  /** Hitscan end, when known; a cannonball has none. */
  ex: number | null;
  ey: number | null;
  ez: number | null;
  weapon: number;
  atMs: number;
  /** Entries this shot has been credited with; a ball breaks through a few cells at once. */
  uses?: number;
}

/** A shot explains at most this many entries. */
const MAX_USES = 3;

/** A shot is looked for this long after it was fired: a cannonball arcs for a while. */
const SHOT_TTL_MS = 5000;
/** How far from the shot's line a break may be and still count as its entry. */
const CORRIDOR_M = 5;
/** A hitscan break within this of the reported end is the entry however the line lies. */
const END_M = 6;
const MAX_SHOTS = 32;

const shots: DustShot[] = [];

export function registerDustShot(shot: DustShot): void {
  const l = Math.hypot(shot.dx, shot.dy, shot.dz) || 1;
  shots.push({ ...shot, dx: shot.dx / l, dy: shot.dy / l, dz: shot.dz / l, uses: 0 });
  if (shots.length > MAX_SHOTS) shots.shift();
}

/** The most recent live shot whose corridor contains the point, or null. */
export function matchDustShot(x: number, y: number, z: number, nowMs: number): DustShot | null {
  for (let i = shots.length - 1; i >= 0; i -= 1) {
    const s = shots[i];
    if (nowMs - s.atMs > SHOT_TTL_MS) {
      shots.splice(0, i + 1);
      break;
    }
    if ((s.uses ?? 0) >= MAX_USES) continue;
    if (s.ex !== null && s.ey !== null && s.ez !== null) {
      if (Math.hypot(x - s.ex, y - s.ey, z - s.ez) <= END_M) {
        s.uses = (s.uses ?? 0) + 1;
        return s;
      }
    }
    const px = x - s.ox;
    const py = y - s.oy;
    const pz = z - s.oz;
    const t = px * s.dx + py * s.dy + pz * s.dz;
    if (t < 0) continue;
    // A thrown ball drops; allow more sag the farther it has flown.
    const sag = s.ex === null ? Math.min(12, 0.5 * (t / 20) * (t / 20) * 9.81) : 0;
    const cx = s.ox + s.dx * t;
    const cy = s.oy + s.dy * t - sag * 0.5;
    const cz = s.oz + s.dz * t;
    if (Math.hypot(x - cx, y - cy, z - cz) <= CORRIDOR_M + sag * 0.5) {
      s.uses = (s.uses ?? 0) + 1;
      return s;
    }
  }
  return null;
}

export function clearDustShots(): void {
  shots.length = 0;
}
