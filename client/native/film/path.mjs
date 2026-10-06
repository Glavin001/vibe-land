// Paths for the closed-loop driver (driver.mjs) and the planner
// (planner.mjs): dense polylines on the ground plane with arc length,
// heading and curvature, built from lines, arcs and smooth offsets, and the
// projection of a point onto them. Pure.
//
// x east, z north; heading psi = atan2(dx, dz) (0 faces +z, pi/2 faces +x),
// so a positive curvature turns psi up -- the car's yaw rate w_y / speed.

const TAU = 2 * Math.PI;
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A path from points [[x, z], ...] (at least two, no repeats): resampled
 * every `step` metres; s, heading, curvature at each sample. `closed`: the
 * last point joins the first (a loop: projection wraps).
 */
export function makePath(points, { step = 0.5, closed = false } = {}) {
  const pts = closed ? [...points, points[0]] : points;
  const out = [[...pts[0]]];
  let carry = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-9) continue;
    let d = step - carry;
    while (d <= len + 1e-9) { out.push([x0 + ((x1 - x0) * d) / len, z0 + ((z1 - z0) * d) / len]); d += step; }
    carry = len - (d - step);
  }
  const last = pts.at(-1), tail = out.at(-1);
  if (!closed && Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.25) out.push([...last]);
  if (closed && Math.hypot(out[0][0] - tail[0], out[0][1] - tail[1]) < step * 0.25) out.pop();
  const n = out.length, x = new Float64Array(n), z = new Float64Array(n), s = new Float64Array(n), psi = new Float64Array(n), kappa = new Float64Array(n);
  for (let i = 0; i < n; i += 1) { x[i] = out[i][0]; z[i] = out[i][1]; if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]); }
  const at = (i) => (closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  for (let i = 0; i < n; i += 1) {
    const a = at(i - 1), b = at(i + 1);
    psi[i] = Math.atan2(x[b] - x[a], z[b] - z[a]);
  }
  // Curvature over +-2 samples (d psi / ds), smoothed once.
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = at(i - 2), b = at(i + 2);
    let ds = 0;
    for (let k = -2; k < 2; k += 1) { const p = at(i + k), q = at(i + k + 1); ds += Math.hypot(x[q] - x[p], z[q] - z[p]); }
    raw[i] = ds > 1e-9 ? wrap(psi[b] - psi[a]) / ds : 0;
  }
  for (let i = 0; i < n; i += 1) kappa[i] = (raw[at(i - 1)] + 2 * raw[i] + raw[at(i + 1)]) / 4;
  const total = closed ? s[n - 1] + Math.hypot(x[0] - x[n - 1], z[0] - z[n - 1]) : s[n - 1];
  return { x, z, s, psi, kappa, n, length: total, closed, step };
}

/** The sample index at arc length s (clamped, or wrapped on a loop). */
export function indexAt(path, s) {
  if (path.closed) s = ((s % path.length) + path.length) % path.length;
  else s = Math.max(0, Math.min(path.length, s));
  let lo = 0, hi = path.n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (path.s[mid] <= s) lo = mid; else hi = mid - 1; }
  return lo;
}

/** The point at arc length s: { x, z, psi, kappa }, interpolated. */
export function pointAt(path, s) {
  if (path.closed) s = ((s % path.length) + path.length) % path.length;
  else s = Math.max(0, Math.min(path.length, s));
  const i = indexAt(path, s), j = path.closed ? (i + 1) % path.n : Math.min(path.n - 1, i + 1);
  const seg = (j === 0 ? path.length : path.s[j]) - path.s[i], f = seg > 1e-9 ? (s - path.s[i]) / seg : 0;
  return {
    x: path.x[i] + (path.x[j] - path.x[i]) * f, z: path.z[i] + (path.z[j] - path.z[i]) * f,
    psi: path.psi[i] + wrap(path.psi[j] - path.psi[i]) * f, kappa: path.kappa[i] + (path.kappa[j] - path.kappa[i]) * f, s,
  };
}

/**
 * The nearest point of the path to (x, z): { s, e, psi, kappa, i } with e
 * the signed lateral offset (positive on the +psi side of the path's
 * heading: along (cos psi, -sin psi)). `hint`: the last s, to search only
 * `window` metres either side of it (a path that crosses itself, a figure
 * eight, is followed through the crossing, not snapped across).
 */
export function project(path, x, z, hint = null, window = 25) {
  let i0 = 0, i1 = path.n - 1;
  if (hint != null) {
    const w = Math.ceil(window / path.step);
    const c = indexAt(path, hint);
    i0 = c - w; i1 = c + w;
    if (!path.closed) { i0 = Math.max(0, i0); i1 = Math.min(path.n - 1, i1); }
  }
  let best = -1, bestD = Infinity;
  for (let k = i0; k <= i1; k += 1) {
    const i = path.closed ? ((k % path.n) + path.n) % path.n : k;
    const d = (path.x[i] - x) ** 2 + (path.z[i] - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  // Refine on the segment either side.
  let s = path.s[best], px = path.x[best], pz = path.z[best];
  for (const j of [best - 1, best + 1]) {
    const jj = path.closed ? (j + path.n) % path.n : j;
    if (jj < 0 || jj >= path.n) continue;
    const ax = path.x[best], az = path.z[best], bx = path.x[jj], bz = path.z[jj];
    const L2 = (bx - ax) ** 2 + (bz - az) ** 2;
    if (L2 < 1e-12) continue;
    const f = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2));
    const qx = ax + (bx - ax) * f, qz = az + (bz - az) * f;
    if ((qx - x) ** 2 + (qz - z) ** 2 < (px - x) ** 2 + (pz - z) ** 2) {
      px = qx; pz = qz;
      const sj = jj === 0 && path.closed && best === path.n - 1 ? path.length : path.s[jj];
      s = path.s[best] + (sj - path.s[best]) * f;
    }
  }
  const psi = path.psi[best];
  const e = (x - px) * Math.cos(psi) - (z - pz) * Math.sin(psi);
  if (path.closed) s = ((s % path.length) + path.length) % path.length;
  return { s, e, psi, kappa: path.kappa[best], i: best, x: px, z: pz };
}

/** Distance along a path from s0 to s1 (forward, wrapping on a loop). */
export function ahead(path, s0, s1) {
  const d = s1 - s0;
  return path.closed ? ((d % path.length) + path.length) % path.length : d;
}

// ------------------------------------------------------------ path builders

/** Points of a straight line from [x, z] along heading psi for `length` m. */
export function linePoints([x, z], psi, length, step = 1) {
  const n = Math.max(1, Math.ceil(length / step));
  return Array.from({ length: n + 1 }, (_, k) => [x + Math.sin(psi) * (length * k) / n, z + Math.cos(psi) * (length * k) / n]);
}

/**
 * Points of an arc from [x, z] at heading psi, turning `angle` radians
 * (positive: psi increases) at radius R. Returns the points and the end pose.
 */
export function arcPoints([x, z], psi, R, angle, step = 1) {
  const n = Math.max(2, Math.ceil((Math.abs(angle) * R) / step));
  const sgn = Math.sign(angle);
  // Centre on the +psi side for a positive turn: along (cos psi, -sin psi).
  const cx = x + sgn * R * Math.cos(psi), cz = z - sgn * R * Math.sin(psi);
  const pts = [];
  for (let k = 0; k <= n; k += 1) {
    const h = psi + (angle * k) / n;
    pts.push([cx - sgn * R * Math.cos(h), cz + sgn * R * Math.sin(h)]);
  }
  const end = pts.at(-1);
  return { points: pts, end: { x: end[0], z: end[1], psi: wrap(psi + angle) } };
}

/**
 * A route of segments from a start pose: [{ line: m } | { arc: radians, R }].
 * Returns its points (joined, no duplicates) and the end pose.
 */
export function route(start, segments, step = 1) {
  let pose = { ...start };
  const points = [[pose.x, pose.z]];
  for (const seg of segments) {
    let pts;
    if (seg.line != null) {
      pts = linePoints([pose.x, pose.z], pose.psi, seg.line, step);
      pose = { x: pts.at(-1)[0], z: pts.at(-1)[1], psi: pose.psi };
    } else {
      const a = arcPoints([pose.x, pose.z], pose.psi, seg.R, seg.arc, step);
      pts = a.points; pose = a.end;
    }
    points.push(...pts.slice(1));
  }
  return { points, end: pose };
}

/** A smooth step 0 -> 1 over u in [0, 1] (quintic: zero slope and curvature at both ends). */
export const smoothstep5 = (u) => { const t = Math.max(0, Math.min(1, u)); return t * t * t * (10 + t * (-15 + 6 * t)); };

/**
 * A path offset sideways from `base` by d(s) metres (positive on the +psi
 * side), sampled from s0 to s1 every `step`. d is a function of arc length.
 */
export function offsetPoints(base, d, s0, s1, step = 1) {
  const pts = [];
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let k = 0; k <= n; k += 1) {
    const s = s0 + ((s1 - s0) * k) / n, p = pointAt(base, s), off = d(s);
    pts.push([p.x + off * Math.cos(p.psi), p.z - off * Math.sin(p.psi)]);
  }
  return pts;
}

export { TAU };
