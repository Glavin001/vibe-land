/**
 * A plane frame or truss as chunks: each joint a convex prism whose sides
 * face the members meeting there, each member a rectangular prism along its
 * axis (in `chunks` pieces), extruded across the plane (z) by its width.
 * Every member end bonds to its joint across the full member section, normal
 * along the member's axis, so the bond carries the member's axial force,
 * shear and moment as the member does; pieces of a member bond to each other
 * the same way. No contact detection: the geometry is built to coincide.
 *
 *   const t = planar({ width: 0.2 });
 *   const a = t.joint('B0', 0, 0), b = t.joint('T1', 4, 3);
 *   t.member(a, b, { depth: 0.2, material, ends: [joint, joint], chunks: 2, type: 'end-post' });
 *   const { pack, names, bonds } = t.build(pack => ...);
 */
import { Pack } from './pack.mjs';

const r6 = (n) => Math.round(n * 1e6) / 1e6 || 0;

/** Convex hull (counter-clockwise) of 2D points. */
function hull2(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 1e-12) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 1e-12) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function polygon(poly) {
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length], w = x0 * y1 - x1 * y0; A += w; cx += (x0 + x1) * w; cy += (y0 + y1) * w; }
  A /= 2; return { area: Math.abs(A), centroid: [cx / (6 * A), cy / (6 * A)] };
}

export function planar({ width, z0 = -width / 2, key = 'planar', title = key } = {}) {
  const joints = [], members = [];
  return {
    joints, members,
    joint(id, x, y, { material = null, type = 'joint', fixed = false, minRadius = 0, extra = [] } = {}) { joints.push({ id, x, y, material, type, fixed, minRadius, extra }); return joints.length - 1; },
    /** A member a -> b: depth (in plane), material (its own), ends [jointMaterial at a, at b], chunks. */
    member(a, b, { depth, material, ends = [material, material], chunks = 1, type = 'member', id = `${joints[a].id}-${joints[b].id}` }) {
      members.push({ a, b, depth, material, ends, chunks, type, id }); return members.length - 1;
    },
    /** pk: build into this Pack (another plane of the same structure); prefix: names. */
    build({ jointMaterial, extra = null, pk = new Pack(key, title), prefix = '' } = {}) {
      const z1 = z0 + width;
      // Each joint's radius: far enough out that neighbouring members clear each other.
      const dir = (j, m) => { const o = members[m], p = joints[o.a === j ? o.b : o.a], q = joints[j], L = Math.hypot(p.x - q.x, p.y - q.y); return [(p.x - q.x) / L, (p.y - q.y) / L]; };
      const radius = joints.map((q, j) => {
        const inc = members.map((m, k) => k).filter((k) => members[k].a === j || members[k].b === j);
        let r = q.minRadius;
        for (const i of inc) for (const k of inc) {
          if (i === k) continue;
          const [ax, ay] = dir(j, i), [bx, by] = dir(j, k), c = Math.max(-1, Math.min(1, ax * bx + ay * by)), th = Math.acos(c);
          const h = Math.max(members[i].depth, members[k].depth) / 2;
          r = Math.max(r, th < Math.PI - 1e-6 ? h / Math.tan(th / 2) * 1.02 : h, members[i].depth / 2);
        }
        return { r, inc };
      });
      const nodeOf = [], bonds = [], polygons = [];
      joints.forEach((q, j) => {
        const { r, inc } = radius[j], pts = [];
        for (const m of inc) { const [dx, dy] = dir(j, m), h = members[m].depth / 2, cx = q.x + r * dx, cy = q.y + r * dy; pts.push([cx - dy * h, cy + dx * h], [cx + dy * h, cy - dx * h]); }
        for (const [x, y] of q.extra) pts.push([x, y]);
        const poly = hull2(pts);
        polygons[j] = poly;
        nodeOf[j] = pk.prism({ poly, z0, z1, material: q.material ?? jointMaterial, type: q.type, name: `${prefix}${q.id}`, fixed: q.fixed });
      });
      const pieces = members.map((m) => {
        const A = joints[m.a], B = joints[m.b], L = Math.hypot(B.x - A.x, B.y - A.y), d = [(B.x - A.x) / L, (B.y - A.y) / L], nrm = [-d[1], d[0]];
        const s0 = radius[m.a].r, s1 = L - radius[m.b].r, h = m.depth / 2, ids = [];
        for (let k = 0; k < m.chunks; k++) {
          const u0 = s0 + (s1 - s0) * k / m.chunks, u1 = s0 + (s1 - s0) * (k + 1) / m.chunks, at = (u, v) => [A.x + d[0] * u + nrm[0] * v, A.y + d[1] * u + nrm[1] * v];
          ids.push(pk.prism({ poly: [at(u0, -h), at(u1, -h), at(u1, h), at(u0, h)], z0, z1, material: m.material, type: m.type, name: `${prefix}${m.id}#${k}` }));
        }
        const face = (u) => [A.x + d[0] * u, A.y + d[1] * u];
        const area = m.depth * width;
        const add = (n0, n1, at, normal, material, key) => { pk.rawBond(n0, n1, { centroid: [...at, (z0 + z1) / 2], normal: [...normal, 0], area, material }); bonds.push(prefix ? { ...key, member: `${prefix}${key.member}` } : key); };
        add(nodeOf[m.a], ids[0], face(s0), d, m.ends[0], { member: m.id, end: 0, type: m.type });
        for (let k = 0; k < m.chunks - 1; k++) add(ids[k], ids[k + 1], face(s0 + (s1 - s0) * (k + 1) / m.chunks), d, m.material, { member: m.id, at: (k + 1) / m.chunks, type: m.type });
        add(ids.at(-1), nodeOf[m.b], face(s1), d, m.ends[1], { member: m.id, end: 1, type: m.type });
        return { ids, L, s0, s1, d };
      });
      if (extra) extra({ pk, nodeOf, pieces, radius, bonds, polygons });
      return { pk, pack: pk.build(), names: pk.names, bonds, nodeOf, pieces, radius, polygons };
    },
  };
}
