// Synthetic test pieces for the Fracture Lab, fractured the way the game's
// packs are: wall-like panels are cut by a 2D Voronoi diagram and extruded
// through their thickness (export-fractured-city.mjs does the same), members
// are sliced across their length. Deterministic from a seed.

import { mulberry32 } from './hash';
import { add, dot, normalize, scale, sub, type Vec2, type Vec3 } from './math';
import { fractureClassOf, type FractureClass } from './materialClass';
import { polytopeFromPoints } from './polytope';
import type { FracturePiece } from './contacts';
import type { RebarFamily } from './rebar';

export interface Specimen {
  key: string;
  title: string;
  pieces: FracturePiece[];
  rebar: RebarFamily[];
  /** Where explosions radiate from (the impact point). */
  impact: Vec3;
  /** Normal of the plane crack/book modes split along. */
  splitNormal: Vec3;
  /** Axis-aligned bounds of the intact specimen. */
  min: Vec3;
  max: Vec3;
}

export const SPECIMEN_KEYS = [
  'rc-wall', 'concrete-wall', 'rc-column', 'rc-slab', 'brick-wall', 'timber-stud', 'drywall', 'glass-pane',
] as const;
export type SpecimenKey = typeof SPECIMEN_KEYS[number];

export const SPECIMEN_TITLES: Record<SpecimenKey, string> = {
  'rc-wall': 'Reinforced concrete wall',
  'concrete-wall': 'Plain concrete wall',
  'rc-column': 'Reinforced concrete column',
  'rc-slab': 'Reinforced concrete slab',
  'brick-wall': 'Brick wall',
  'timber-stud': 'Timber stud',
  drywall: 'Drywall sheet',
  'glass-pane': 'Glass pane',
};

export function buildSpecimen(key: SpecimenKey, seed = 7): Specimen {
  switch (key) {
    case 'rc-wall': return wall(key, 'reinforced-concrete', 4, 3, 0.2, 40, seed, true);
    case 'concrete-wall': return wall(key, 'concrete', 4, 3, 0.2, 40, seed, false);
    case 'brick-wall': return wall(key, 'brick', 3.2, 2.4, 0.23, 26, seed, false);
    case 'drywall': return wall(key, 'drywall', 1.2, 2.4, 0.0125, 14, seed, false);
    case 'glass-pane': return wall(key, 'window-glass', 1.0, 1.4, 0.008, 30, seed, false, 0.85);
    case 'rc-slab': return slab(seed);
    case 'rc-column': return column(seed);
    case 'timber-stud': return stud(seed);
  }
}

// --- Voronoi panels -------------------------------------------------------

/** Seeds clustered round an impact point, like a real fracture pattern. */
function impactSeeds(w: number, h: number, count: number, rng: () => number, focus: Vec2, clustered: number): Vec2[] {
  const seeds: Vec2[] = [];
  const spread = Math.min(w, h) * 0.28;
  while (seeds.length < count) {
    let p: Vec2;
    if (rng() < clustered) {
      // Radial falloff: more seeds, so smaller pieces, near the impact.
      const r = spread * Math.pow(rng(), 1.6) * 2.2;
      const a = rng() * Math.PI * 2;
      p = [focus[0] + Math.cos(a) * r, focus[1] + Math.sin(a) * r];
    } else {
      p = [rng() * w, rng() * h];
    }
    if (p[0] <= 0.01 || p[0] >= w - 0.01 || p[1] <= 0.01 || p[1] >= h - 0.01) continue;
    if (seeds.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.02)) continue;
    seeds.push(p);
  }
  return seeds;
}

/** The Voronoi cell of each seed within the rectangle, CCW. */
export function voronoiCells(w: number, h: number, seeds: readonly Vec2[]): Vec2[][] {
  return seeds.map((s, i) => {
    let cell: Vec2[] = [[0, 0], [w, 0], [w, h], [0, h]];
    for (let j = 0; j < seeds.length && cell.length > 0; j += 1) {
      if (j === i) continue;
      const o = seeds[j];
      const mx = (s[0] + o[0]) / 2;
      const my = (s[1] + o[1]) / 2;
      const nx = o[0] - s[0];
      const ny = o[1] - s[1];
      // Keep points with (p - m) . (o - s) <= 0.
      const next: Vec2[] = [];
      for (let k = 0; k < cell.length; k += 1) {
        const p = cell[k];
        const q = cell[(k + 1) % cell.length];
        const dp = (p[0] - mx) * nx + (p[1] - my) * ny;
        const dq = (q[0] - mx) * nx + (q[1] - my) * ny;
        if (dp <= 0) next.push(p);
        if ((dp <= 0) !== (dq <= 0)) {
          const t = dp / (dp - dq);
          next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
      cell = next;
    }
    return cell;
  });
}

function cellCentroid(cell: readonly Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = cell.length - 1; i < cell.length; j = i, i += 1) {
    const cr = cell[j][0] * cell[i][1] - cell[i][0] * cell[j][1];
    a += cr;
    cx += (cell[j][0] + cell[i][0]) * cr;
    cy += (cell[j][1] + cell[i][1]) * cr;
  }
  return a !== 0 ? [cx / (3 * a), cy / (3 * a)] : cell[0];
}

/**
 * Cut a rectangular panel into extruded Voronoi prisms. The panel spans
 * `u` (width) and `v` (height) from `origin`, `thickness` along `n`.
 */
function voronoiPanel(
  material: string, w: number, h: number, thickness: number, cells: number, seed: number,
  origin: Vec3, u: Vec3, v: Vec3, n: Vec3, focus: Vec2, clustered: number,
): FracturePiece[] {
  const rng = mulberry32(seed);
  let seeds = impactSeeds(w, h, cells, rng, focus, clustered);
  // One Lloyd step evens out slivers without erasing the impact cluster.
  seeds = voronoiCells(w, h, seeds).map((cell, i) => (cell.length >= 3 ? cellCentroid(cell) : seeds[i]));
  const cls = fractureClassOf(material);
  const pieces: FracturePiece[] = [];
  for (const cell of voronoiCells(w, h, seeds)) {
    if (cell.length < 3) continue;
    const c2 = cellCentroid(cell);
    const centroid = add(origin, add(scale(u, c2[0]), scale(v, c2[1])));
    const points: number[] = [];
    for (const [x, y] of cell) {
      for (const side of [-0.5, 0.5]) {
        const p = add(add(origin, add(scale(u, x), scale(v, y))), scale(n, thickness * side));
        points.push(p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]);
      }
    }
    const poly = polytopeFromPoints(points);
    if (poly) pieces.push({ centroid, poly, material, cls });
  }
  return pieces;
}

function bounds(pieces: readonly FracturePiece[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pieces) {
    for (const v of p.poly.verts) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], v[k] + p.centroid[k]);
        max[k] = Math.max(max[k], v[k] + p.centroid[k]);
      }
    }
  }
  return { min, max };
}

/** Two mats of bars, horizontal outside vertical, at each face of a panel. */
function panelMats(
  u: Vec3, v: Vec3, n: Vec3, thickness: number, origin: Vec3, spacing: number, cover: number, radius: number,
): RebarFamily[] {
  const outer = thickness / 2 - cover - radius;
  const inner = outer - 2 * radius;
  const families: RebarFamily[] = [];
  for (const side of [-1, 1]) {
    // Bars along u, spaced along v.
    families.push({
      dir: u, across: v, spacing, phase: dot(origin, v) + spacing / 2,
      depthAxis: n, depth: dot(origin, n) + side * outer, radius,
    });
    // Bars along v, spaced along u.
    families.push({
      dir: v, across: u, spacing, phase: dot(origin, u) + spacing / 2,
      depthAxis: n, depth: dot(origin, n) + side * inner, radius,
    });
  }
  return families;
}

function wall(
  key: SpecimenKey, material: string, w: number, h: number, t: number, cells: number,
  seed: number, reinforced: boolean, clustered = 0.6,
): Specimen {
  const origin: Vec3 = [-w / 2, 0, 0];
  const u: Vec3 = [1, 0, 0];
  const v: Vec3 = [0, 1, 0];
  const n: Vec3 = [0, 0, 1];
  const focus: Vec2 = [w * 0.38, h * 0.55];
  const pieces = voronoiPanel(material, w, h, t, cells, seed, origin, u, v, n, focus, clustered);
  const { min, max } = bounds(pieces);
  return {
    key, title: SPECIMEN_TITLES[key], pieces,
    rebar: reinforced ? panelMats(u, v, n, t, [0, 0, 0], 0.2, 0.04, 0.008) : [],
    impact: [origin[0] + focus[0], focus[1], 0],
    splitNormal: [1, 0, 0],
    min, max,
  };
}

function slab(seed: number): Specimen {
  const w = 3;
  const d = 3;
  const t = 0.2;
  const origin: Vec3 = [-w / 2, 1.0, -d / 2];
  const u: Vec3 = [1, 0, 0];
  const v: Vec3 = [0, 0, 1];
  const n: Vec3 = [0, -1, 0];
  const focus: Vec2 = [w * 0.45, d * 0.5];
  const pieces = voronoiPanel('concrete-slab', w, d, t, 34, seed, origin, u, v, n, focus, 0.55);
  const { min, max } = bounds(pieces);
  return {
    key: 'rc-slab', title: SPECIMEN_TITLES['rc-slab'], pieces,
    rebar: panelMats(u, v, n, t, [0, 1.0, 0], 0.2, 0.03, 0.006),
    impact: [origin[0] + focus[0], 1.0, origin[2] + focus[1]],
    splitNormal: [1, 0, 0],
    min, max,
  };
}

// --- Sliced members -------------------------------------------------------

/**
 * Slice an axis-aligned box into pieces by planes that do not meet inside it
 * (ordered along the member). Each piece is the hull of the box corners
 * between its two planes plus where the box edges cross them.
 */
function sliceBox(
  material: string, center: Vec3, half: Vec3, planes: Array<{ n: Vec3; d: number }>, grainAxis?: number,
): FracturePiece[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    corners.push([center[0] + sx * half[0], center[1] + sy * half[1], center[2] + sz * half[2]]);
  }
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) {
      let diff = 0;
      for (let k = 0; k < 3; k += 1) if (corners[i][k] !== corners[j][k]) diff += 1;
      if (diff === 1) edges.push([i, j]);
    }
  }
  const cuts = (plane: { n: Vec3; d: number }): Vec3[] => {
    const out: Vec3[] = [];
    for (const [i, j] of edges) {
      const di = dot(plane.n, corners[i]) - plane.d;
      const dj = dot(plane.n, corners[j]) - plane.d;
      if ((di < 0) !== (dj < 0)) {
        const t = di / (di - dj);
        out.push(add(corners[i], scale(sub(corners[j], corners[i]), t)));
      }
    }
    return out;
  };
  const cls = fractureClassOf(material);
  const pieces: FracturePiece[] = [];
  for (let k = 0; k <= planes.length; k += 1) {
    const below = k < planes.length ? planes[k] : null;
    const above = k > 0 ? planes[k - 1] : null;
    const pts: Vec3[] = corners.filter((c) =>
      (!above || dot(above.n, c) - above.d >= 0) && (!below || dot(below.n, c) - below.d < 0));
    if (above) pts.push(...cuts(above));
    if (below) pts.push(...cuts(below));
    if (pts.length < 4) continue;
    const centroid = scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / pts.length);
    const poly = polytopeFromPoints(pts.flatMap((p) => [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]]));
    if (poly) pieces.push({ centroid, poly, material, cls: cls as FractureClass, grainAxis });
  }
  return pieces;
}

function tiltedPlanes(levels: number[], rng: () => number, tilt: number, axis: number): Array<{ n: Vec3; d: number }> {
  return levels.map((at) => {
    const n: Vec3 = [(rng() - 0.5) * tilt, (rng() - 0.5) * tilt, (rng() - 0.5) * tilt];
    n[axis] = 1;
    const nn = normalize(n);
    const p: Vec3 = [0, 0, 0];
    p[axis] = at;
    return { n: nn, d: dot(nn, p) };
  });
}

function column(seed: number): Specimen {
  const rng = mulberry32(seed + 3);
  const half: Vec3 = [0.2, 1.5, 0.2];
  const center: Vec3 = [0, 1.5, 0];
  const pieces = sliceBox('reinforced-concrete', center, half, tiltedPlanes([0.85, 1.55, 2.2], rng, 0.5, 1));
  const { min, max } = bounds(pieces);
  const r = 0.01;
  const inset = 0.2 - 0.04 - r;
  const families: RebarFamily[] = [-1, 1].map((side) => ({
    dir: [0, 1, 0] as Vec3, across: [1, 0, 0] as Vec3, spacing: inset * 2, phase: -inset,
    depthAxis: [0, 0, 1] as Vec3, depth: side * inset, radius: r,
  }));
  return {
    key: 'rc-column', title: SPECIMEN_TITLES['rc-column'], pieces, rebar: families,
    impact: [0, 1.5, 0.2], splitNormal: [0, 1, 0], min, max,
  };
}

function stud(seed: number): Specimen {
  const rng = mulberry32(seed + 5);
  const half: Vec3 = [0.0225, 1.2, 0.045];
  const center: Vec3 = [0, 1.2, 0];
  const pieces = sliceBox('stud-timber', center, half, tiltedPlanes([0.95, 1.5], rng, 1.2, 1), 1);
  const { min, max } = bounds(pieces);
  return {
    key: 'timber-stud', title: SPECIMEN_TITLES['timber-stud'], pieces, rebar: [],
    impact: [0, 1.2, 0.05], splitNormal: [0, 1, 0], min, max,
  };
}
