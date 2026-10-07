/**
 * A calibration structure as a ScenePack v2: box chunks and the bonds the
 * structure has, each named, nothing implicit. Two boxes bond across the face
 * they share (its rectangle is the bond's patch: area, centroid, normal from
 * the first to the second), with the material the joint is.
 *
 * Cases of a scenario are composed side by side (`cases`), one node group
 * `case@<id>` each, for one GPU run (server/src/calibration.rs).
 */
import { composeScene } from '../../town-kit/src/geometry.mjs';

const r6 = (n) => Math.round(n * 1e6) / 1e6 || 0;
const vec = (a) => ({ x: r6(a[0]), y: r6(a[1]), z: r6(a[2]) });

export class Pack {
  constructor(key, title = key) {
    this.key = key; this.title = title; this.materials = []; this.byName = new Map();
    this.boxes = []; this.s = { nodes: [], bonds: [], nodeSizes: [], nodeColliders: [], nodeTypes: [], nodeMaterials: [], nodePieces: [], nodeGroups: [] };
    this.names = []; this.pieceId = 0;
  }
  /** A material's index (added once, by name). */
  material(m) {
    if (!this.byName.has(m.name)) { this.byName.set(m.name, this.materials.length); this.materials.push(structuredClone(m)); }
    return this.byName.get(m.name);
  }
  /** A box chunk; `fixed` makes it an anchor (mass 0). Returns its node index. */
  box({ min, max, material, type, name = type, fixed = false, piece = this.pieceId++ }) {
    for (let k = 0; k < 3; k++) if (!(max[k] > min[k])) throw Error(`empty box ${name}: ${min} ${max}`);
    const m = this.material(material), size = max.map((x, k) => x - min[k]), volume = size[0] * size[1] * size[2];
    const s = this.s;
    s.nodes.push({ centroid: vec(min.map((x, k) => (x + max[k]) / 2)), mass: fixed ? 0 : r6(volume * this.materials[m].density), volume: r6(volume), m });
    s.nodeSizes.push(vec(size)); s.nodeColliders.push({ kind: 'cuboid', halfExtents: vec(size.map((x) => x / 2)) });
    s.nodeTypes.push(type); s.nodeMaterials.push(this.materials[m].name); s.nodePieces.push(piece); s.nodeGroups.push('structure');
    this.boxes.push({ min: [...min], max: [...max] }); this.names.push(name);
    return s.nodes.length - 1;
  }
  /**
   * A prism: the convex polygon `poly` ([[x, y], ...] in the xy plane, either
   * winding) extruded from z0 to z1, as a convex-hull chunk referenced at its
   * volume centroid.
   */
  prism({ poly, z0, z1, material, type, name = type, fixed = false, piece = this.pieceId++ }) {
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length], w = x0 * y1 - x1 * y0; A += w; cx += (x0 + x1) * w; cy += (y0 + y1) * w; }
    cx /= 3 * A; cy /= 3 * A; A = Math.abs(A) / 2;
    if (!(A > 1e-9)) throw Error(`degenerate prism ${name}`);
    const m = this.material(material), c = [cx, cy, (z0 + z1) / 2], volume = A * (z1 - z0), s = this.s;
    const pts = poly.flatMap(([x, y]) => [[x, y, z0], [x, y, z1]]);
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])));
    s.nodes.push({ centroid: vec(c), mass: fixed ? 0 : r6(volume * this.materials[m].density), volume: r6(volume), m });
    s.nodeSizes.push(vec(hi.map((x, k) => x - lo[k])));
    s.nodeColliders.push({ kind: 'convex_hull', points: pts.flatMap((q) => q.map((x, k) => r6(x - c[k]))) });
    s.nodeTypes.push(type); s.nodeMaterials.push(this.materials[m].name); s.nodePieces.push(piece); s.nodeGroups.push('structure');
    this.boxes.push({ min: lo, max: hi }); this.names.push(name);
    return s.nodes.length - 1;
  }
  /** A bond given outright (centroid, unit normal from i to j, area). */
  rawBond(i, j, { centroid, normal, area, material }) {
    this.s.bonds.push({ node0: i, node1: j, centroid: vec(centroid), normal: vec(normal), area: r6(area), m: this.material(material) });
    return this.s.bonds.length - 1;
  }
  /** The bond across the face boxes i and j share, of material `material`. */
  bond(i, j, material, { area = null } = {}) {
    const a = this.boxes[i], b = this.boxes[j], lo = [0, 1, 2].map((k) => Math.max(a.min[k], b.min[k])), hi = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]));
    const ov = hi.map((x, k) => x - lo[k]), touching = ov.map((x) => Math.abs(x) < 1e-6);
    if (touching.filter(Boolean).length !== 1 || ov.some((x, k) => !touching[k] && x <= 1e-6)) throw Error(`bond ${this.names[i]} - ${this.names[j]}: boxes do not share a face (${ov.map((x) => x.toFixed(3))})`);
    const k = touching.indexOf(true), normal = [0, 0, 0];
    normal[k] = (b.min[k] + b.max[k]) / 2 > (a.min[k] + a.max[k]) / 2 ? 1 : -1;
    const [u, w] = [0, 1, 2].filter((q) => q !== k), patch = ov[u] * ov[w];
    this.s.bonds.push({ node0: i, node1: j, centroid: vec(lo.map((x, q) => (x + hi[q]) / 2)), normal: vec(normal), area: r6(area ?? patch), m: this.material(material) });
    return this.s.bonds.length - 1;
  }
  build() {
    return { version: 2, key: this.key, title: this.title, defaults: { solver: { gravity: -9.81, materials: this.materials } }, scenario: structuredClone(this.s) };
  }
}

/**
 * The cases of a scenario side by side: case k at `offset(k)`, its node group
 * `case@<id>` (server/src/calibration.rs reports per case).
 */
export function cases(list, { key, title = key }) {
  return composeScene(list.map(({ id, pack, position }) => ({ pack, position, yaw: 0, group: `case@${id}` })), { key, title });
}

/** A pack without the nodes `drop(i)` selects, and their bonds (as town-kit veneer-houses withoutNodes). */
export function withoutNodes(pack, drop) {
  const p = structuredClone(pack), s = p.scenario, keep = [], map = new Map(), n = pack.scenario.nodes.length;
  for (let i = 0; i < n; i++) if (!drop(i)) { map.set(i, keep.length); keep.push(i); }
  for (const k of Object.keys(s)) if (Array.isArray(s[k]) && s[k].length === n && k !== 'bonds') s[k] = keep.map((i) => s[k][i]);
  s.bonds = s.bonds.filter((x) => map.has(x.node0) && map.has(x.node1)).map((x) => ({ ...x, node0: map.get(x.node0), node1: map.get(x.node1) }));
  return { pack: p, map };
}
