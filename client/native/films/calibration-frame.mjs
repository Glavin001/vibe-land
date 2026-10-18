// Camera framing for the calibration film (calibration.mjs): boxes from a
// scenario's scene pack and spec, and the camera that fits a box in frame.
// Pure (no game), so the framing can be checked in node away from the app.

const DEG = Math.PI / 180;
const sub = (a, b) => a.map((v, k) => v - b[k]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const xyz = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);

/** An empty box, grown by points and boxes. */
export const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
export function grow(box, p, half = [0, 0, 0]) {
  for (let k = 0; k < 3; k += 1) {
    box.min[k] = Math.min(box.min[k], p[k] - half[k]);
    box.max[k] = Math.max(box.max[k], p[k] + half[k]);
  }
  return box;
}
export const union = (boxes) => boxes.reduce((u, b) => grow(grow(u, b.min), b.max), emptyBox());
export const centre = (box) => box.min.map((v, k) => (v + box.max[k]) / 2);
export const size = (box) => box.max.map((v, k) => v - box.min[k]);
/** The box grown by `pad` metres along each axis ([x, y, z] or one number). */
export const padded = (box, pad) => {
  const p = Array.isArray(pad) ? pad : [pad, pad, pad];
  return { min: box.min.map((v, k) => v - p[k]), max: box.max.map((v, k) => v + p[k]) };
};

/** The box of nodes [from, to) of a scene pack (centroids and sizes). */
export function nodesBox(scenario, [from, to]) {
  const box = emptyBox();
  for (let i = from; i < to; i += 1) grow(box, xyz(scenario.nodes[i].centroid), xyz(scenario.nodeSizes[i]).map((v) => v / 2));
  return box;
}

/**
 * Where a case's hand calculation says it is worked hardest: the bonds at
 * `share` or more of its worst utilisation (every bond over 1 when any is),
 * as a box of their patch centres. Null when the prediction names no bonds.
 */
export function criticalBox(scenario, c, share = 0.6) {
  const p = c.predictions?.real;
  const bonds = p?.bonds ?? {};
  const top = Math.max(0, ...Object.values(bonds));
  const keys = Object.entries(bonds).filter(([, u]) => (top > 1 ? u > 1 : u >= share * top)).map(([k]) => k);
  if (p?.worst && !keys.includes(p.worst)) keys.push(p.worst);
  const box = emptyBox();
  for (const key of keys) {
    const j = c.bondKeys?.indexOf(key) ?? -1;
    const bond = j >= 0 ? scenario.bonds[c.bonds[0] + j] : null;
    if (bond) grow(box, xyz(bond.centroid));
  }
  return Number.isFinite(box.min[0]) ? box : null;
}

/** The compass bearing (degrees: 0 looks from +z, 90 from +x) square to a box's long horizontal side, from its -z (or -x) side. */
export const sideBearing = (box) => (size(box)[0] >= size(box)[2] ? 180 : 270);

/** The direction from a target to a camera at `bearing` and `elevation` (degrees). */
export const direction = (bearing, elevation) => [
  Math.sin(bearing * DEG) * Math.cos(elevation * DEG), Math.sin(elevation * DEG), Math.cos(bearing * DEG) * Math.cos(elevation * DEG),
];

/**
 * The app's far plane is 200 m (RenderGovernor): beyond it the frame is
 * black. fit() widens the lens until every corner is within this.
 */
export const REACH_M = 185;

/**
 * The camera that fits `box` in a 16:9 frame of vertical field of view `fov`
 * (degrees), from `bearing` and `elevation`, looking at `lookAt` (the box's
 * centre by default): the nearest distance at which every corner is inside
 * `margin` of the frame. Never under `minHeight` metres; the lens widened (to
 * 85 degrees at most) while a corner is further than `reach` metres. Returns
 * { position, lookAt, fov, distance, reach }.
 */
export function fit(box, opts = {}) {
  const reach = opts.reach ?? REACH_M;
  let pose = fitOnce(box, opts);
  while (pose.reach > reach && pose.fov < 85) pose = fitOnce(box, { ...opts, fov: pose.fov + 5 });
  return pose;
}

function fitOnce(box, { bearing = sideBearing(box), elevation = 15, fov = 40, aspect = 16 / 9, margin = 0.86, lookAt, minHeight = 1.5 } = {}) {
  const target = lookAt ?? centre(box);
  const d = direction(bearing, elevation);
  const f = d.map((v) => -v), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const tv = Math.tan((fov * DEG) / 2) * margin, th = tv * aspect;
  const corners = [];
  for (let i = 0; i < 8; i += 1) corners.push([0, 1, 2].map((k) => ((i >> k) & 1 ? box.max[k] : box.min[k])));
  const fits = (dist) => corners.every((p) => {
    const v = sub(p, target.map((t, k) => t + d[k] * dist));
    const z = dot(v, f);
    return z > 0.5 && Math.abs(dot(v, r)) <= th * z && Math.abs(dot(v, u)) <= tv * z;
  });
  let lo = 0.5, hi = 4000;
  if (fits(hi)) for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  const position = target.map((t, k) => t + d[k] * hi);
  position[1] = Math.max(minHeight, position[1]);
  const far = Math.max(...corners.map((p) => Math.hypot(...sub(p, position))));
  return { position, lookAt: target, fov, distance: hi, reach: far };
}
