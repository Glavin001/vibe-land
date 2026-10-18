// Camera motion for films (client/native/film): centripetal Catmull-Rom
// splines through keyframes, travelled at an even speed by arc length, with
// eased ends. One spline through every keyframe of a move keeps the camera
// moving through them; a chain of separately eased segments stops at each.

const sub = (a, b) => a.map((v, k) => v - b[k]);
const dist = (a, b) => Math.hypot(...sub(a, b));
const lerp = (a, b, ta, tb, t) => (tb - ta < 1e-9 ? a : a.map((v, k) => v + (b[k] - v) * ((t - ta) / (tb - ta))));

/** One centripetal Catmull-Rom segment p1 -> p2 (Barry-Goldman), u in [0, 1]. */
function segment(p0, p1, p2, p3, u) {
  const knot = (t, a, b) => t + Math.max(1e-4, Math.sqrt(dist(a, b)));
  const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
  const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
  return lerp(b1, b2, t1, t2, t);
}

/** A curve through `points` (2+), at knot parameter tau in [0, n - 1]. Ends extend straight. */
export function catmullRom(points) {
  const n = points.length;
  if (n === 1) return () => [...points[0]];
  const at = (i) => (i < 0 ? sub(points[0], sub(points[1], points[0]))
    : i >= n ? points[n - 1].map((v, k) => 2 * v - points[n - 2][k]) : points[i]);
  return (tau) => {
    const i = Math.min(n - 2, Math.max(0, Math.floor(tau)));
    return segment(at(i - 1), at(i), at(i + 1), at(i + 2), Math.min(1, Math.max(0, tau - i)));
  };
}

/**
 * Progress through a move, 0..1, at time fraction u: an even speed with
 * cosine ramps of `ramp` (a fraction of the move) at the eased ends --
 * 'both', 'in', 'out' or 'none'. Speed is continuous; it is zero only at an
 * eased end, so a move eased 'out' into one eased 'in' slows and starts again,
 * and one left uneased ('none') at a join keeps going (at its own speed).
 */
export function easeProgress(u, ease = 'both', ramp = 0.25) {
  u = Math.min(1, Math.max(0, u));
  const easeIn = ease === 'both' || ease === 'in', easeOut = ease === 'both' || ease === 'out';
  const r = Math.min(0.5, Math.max(1e-3, ramp));
  // Distance covered by a cosine ramp of length r at unit top speed: r / 2.
  const rampIn = (x) => x / 2 - (r / (2 * Math.PI)) * Math.sin((Math.PI * x) / r);
  const total = 1 - (easeIn ? r / 2 : 0) - (easeOut ? r / 2 : 0);
  let s;
  if (easeIn && u < r) s = rampIn(u);
  else if (easeOut && u > 1 - r) s = total - rampIn(1 - u);
  else s = (easeIn ? r / 2 : 0) + (u - (easeIn ? r : 0));
  return Math.min(1, Math.max(0, s / total));
}

/**
 * A camera move through keyframe poses ({ position, lookAt } as vectors):
 * returns pose(s) for progress s in 0..1, by arc length -- the camera's
 * travel, plus a quarter of the look point's, so a pan in place still moves
 * evenly.
 */
export function posePath(poses, { samples = 48, lookWeight = 0.25 } = {}) {
  const position = catmullRom(poses.map((p) => p.position));
  const lookAt = catmullRom(poses.map((p) => p.lookAt));
  const span = poses.length - 1;
  const table = [{ tau: 0, length: 0 }];
  if (span > 0) {
    let prev = { p: position(0), l: lookAt(0) }, length = 0;
    for (let k = 1; k <= span * samples; k += 1) {
      const tau = k / samples;
      const next = { p: position(tau), l: lookAt(tau) };
      length += dist(prev.p, next.p) + lookWeight * dist(prev.l, next.l);
      table.push({ tau, length });
      prev = next;
    }
  }
  const total = table[table.length - 1].length;
  const tauAt = (s) => {
    if (total < 1e-9) return s * span;
    const want = s * total;
    let lo = 0, hi = table.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (table[mid].length < want) lo = mid; else hi = mid; }
    const a = table[lo], b = table[hi];
    return b.length - a.length < 1e-9 ? a.tau : a.tau + (b.tau - a.tau) * ((want - a.length) / (b.length - a.length));
  };
  const pose = (s) => { const tau = tauAt(Math.min(1, Math.max(0, s))); return { position: position(tau), lookAt: lookAt(tau) }; };
  pose.arcLength = total;
  return pose;
}
