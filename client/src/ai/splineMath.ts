import type { SplineData, SplinePoint } from './splineData';

type ArcEntry = { t: number; distance: number };

function evaluatePolyline(points: SplinePoint[], t: number, closed: boolean): SplinePoint {
  const n = points.length;
  if (n === 0) return { x: 0, z: 0 };
  if (n === 1) return { x: points[0].x, z: points[0].z };

  const segCount = closed ? n : n - 1;
  const scaledT = t * segCount;
  const seg = Math.min(Math.floor(scaledT), segCount - 1);
  const frac = scaledT - seg;

  const p0 = points[seg % n];
  const p1 = points[(seg + 1) % n];

  return {
    x: p0.x + (p1.x - p0.x) * frac,
    z: p0.z + (p1.z - p0.z) * frac,
  };
}

function evaluateCatmullRom(
  points: SplinePoint[],
  t: number,
  tension: number,
  closed: boolean,
): SplinePoint {
  const n = points.length;
  if (n === 0) return { x: 0, z: 0 };
  if (n === 1) return { x: points[0].x, z: points[0].z };

  const segCount = closed ? n : n - 1;
  const scaledT = t * segCount;
  const seg = Math.min(Math.floor(scaledT), segCount - 1);
  const frac = scaledT - seg;

  const getPoint = (i: number): SplinePoint => {
    if (closed) {
      return points[((i % n) + n) % n];
    }
    if (i < 0) return { x: 2 * points[0].x - points[1].x, z: 2 * points[0].z - points[1].z };
    if (i >= n) return { x: 2 * points[n - 1].x - points[n - 2].x, z: 2 * points[n - 1].z - points[n - 2].z };
    return points[i];
  };

  const p0 = getPoint(seg - 1);
  const p1 = getPoint(seg);
  const p2 = getPoint(seg + 1);
  const p3 = getPoint(seg + 2);

  const alpha = 1 - tension;
  const tt = frac;
  const tt2 = tt * tt;
  const tt3 = tt2 * tt;

  const m1x = alpha * (p2.x - p0.x) * 0.5;
  const m1z = alpha * (p2.z - p0.z) * 0.5;
  const m2x = alpha * (p3.x - p1.x) * 0.5;
  const m2z = alpha * (p3.z - p1.z) * 0.5;

  return {
    x: (2 * tt3 - 3 * tt2 + 1) * p1.x + (tt3 - 2 * tt2 + tt) * m1x + (-2 * tt3 + 3 * tt2) * p2.x + (tt3 - tt2) * m2x,
    z: (2 * tt3 - 3 * tt2 + 1) * p1.z + (tt3 - 2 * tt2 + tt) * m1z + (-2 * tt3 + 3 * tt2) * p2.z + (tt3 - tt2) * m2z,
  };
}

function evaluateSpline(spline: SplineData, t: number): SplinePoint {
  const clamped = Math.max(0, Math.min(1, t));
  if (spline.interpolation === 'catmull-rom') {
    return evaluateCatmullRom(spline.points, clamped, spline.tension, spline.closed);
  }
  return evaluatePolyline(spline.points, clamped, spline.closed);
}

export function buildArcLengthTable(spline: SplineData, sampleCount?: number): ArcEntry[] {
  const n = sampleCount ?? Math.max(256, spline.points.length * 64);
  const table: ArcEntry[] = new Array(n + 1);
  let prev = evaluateSpline(spline, 0);
  table[0] = { t: 0, distance: 0 };
  let cumulative = 0;

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const curr = evaluateSpline(spline, t);
    cumulative += Math.hypot(curr.x - prev.x, curr.z - prev.z);
    table[i] = { t, distance: cumulative };
    prev = curr;
  }

  return table;
}

export function computeSplineLength(spline: SplineData): number {
  const table = buildArcLengthTable(spline);
  return table[table.length - 1].distance;
}

function tFromDistance(distance: number, arcTable: ArcEntry[]): number {
  const totalLen = arcTable[arcTable.length - 1].distance;
  if (totalLen <= 0) return 0;
  const d = Math.max(0, Math.min(totalLen, distance));

  let lo = 0;
  let hi = arcTable.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (arcTable[mid].distance < d) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const segLen = arcTable[hi].distance - arcTable[lo].distance;
  if (segLen <= 0) return arcTable[lo].t;
  const frac = (d - arcTable[lo].distance) / segLen;
  return arcTable[lo].t + (arcTable[hi].t - arcTable[lo].t) * frac;
}

export function sampleSplineAtDistance(
  spline: SplineData,
  distance: number,
  arcTable: ArcEntry[],
): SplinePoint {
  const t = tFromDistance(distance, arcTable);
  return evaluateSpline(spline, t);
}

export function tangentAtDistance(
  spline: SplineData,
  distance: number,
  arcTable: ArcEntry[],
): SplinePoint {
  const eps = 1e-6;
  const t = tFromDistance(distance, arcTable);
  const tA = Math.max(0, t - eps);
  const tB = Math.min(1, t + eps);
  const pA = evaluateSpline(spline, tA);
  const pB = evaluateSpline(spline, tB);
  const dx = pB.x - pA.x;
  const dz = pB.z - pA.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-12) return { x: 1, z: 0 };
  return { x: dx / len, z: dz / len };
}

export function normalAtDistance(
  spline: SplineData,
  distance: number,
  arcTable: ArcEntry[],
): SplinePoint {
  const tan = tangentAtDistance(spline, distance, arcTable);
  return { x: tan.z, z: -tan.x };
}

export function resampleSplineBySpacing(spline: SplineData, spacing: number): SplinePoint[] {
  const table = buildArcLengthTable(spline);
  const totalLen = table[table.length - 1].distance;
  if (totalLen <= 0 || spacing <= 0) return [];

  const result: SplinePoint[] = [];
  for (let d = 0; d <= totalLen + 1e-9; d += spacing) {
    result.push(sampleSplineAtDistance(spline, d, table));
  }
  return result;
}

export function offsetSplineCurve(
  spline: SplineData,
  offset: number,
  spacing?: number,
): SplinePoint[] {
  const sp = spacing ?? 1;
  const table = buildArcLengthTable(spline);
  const totalLen = table[table.length - 1].distance;
  if (totalLen <= 0 || sp <= 0) return [];

  const result: SplinePoint[] = [];
  for (let d = 0; d <= totalLen + 1e-9; d += sp) {
    const p = sampleSplineAtDistance(spline, d, table);
    const n = normalAtDistance(spline, d, table);
    result.push({ x: p.x + n.x * offset, z: p.z + n.z * offset });
  }
  return result;
}

export function computeSplineBounds(
  spline: SplineData,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const table = buildArcLengthTable(spline);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < table.length; i++) {
    const p = evaluateSpline(spline, table[i].t);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  return { minX, maxX, minZ, maxZ };
}

function segmentIntersection(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): SplinePoint | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;

  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-12) return null;

  const qpx = cx - ax;
  const qpz = cz - az;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: ax + t * rx, z: az + t * rz };
  }
  return null;
}

export function findSplineSelfIntersections(
  spline: SplineData,
  sampleCount?: number,
): SplinePoint[] {
  const count = sampleCount ?? Math.max(256, spline.points.length * 64);
  const pts: SplinePoint[] = new Array(count + 1);
  for (let i = 0; i <= count; i++) {
    pts[i] = evaluateSpline(spline, i / count);
  }

  const intersections: SplinePoint[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (i === 0 && j === pts.length - 2) continue;
      const hit = segmentIntersection(
        pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z,
        pts[j].x, pts[j].z, pts[j + 1].x, pts[j + 1].z,
      );
      if (hit) intersections.push(hit);
    }
  }

  return intersections;
}

export function projectPointOntoSpline(
  spline: SplineData,
  point: SplinePoint,
  arcTable: ArcEntry[],
): { along: number; across: number } {
  let bestDistSq = Infinity;
  let bestIdx = 0;

  for (let i = 0; i < arcTable.length; i++) {
    const p = evaluateSpline(spline, arcTable[i].t);
    const dx = p.x - point.x;
    const dz = p.z - point.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIdx = i;
    }
  }

  // Refine within neighboring samples
  const lo = Math.max(0, bestIdx - 1);
  const hi = Math.min(arcTable.length - 1, bestIdx + 1);
  const tLo = arcTable[lo].t;
  const tHi = arcTable[hi].t;

  let refinedT = arcTable[bestIdx].t;
  let refinedDistSq = bestDistSq;
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const t = tLo + (tHi - tLo) * (i / steps);
    const p = evaluateSpline(spline, t);
    const dx = p.x - point.x;
    const dz = p.z - point.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < refinedDistSq) {
      refinedDistSq = distSq;
      refinedT = t;
    }
  }

  // Compute along distance by interpolating arc table
  let along = 0;
  {
    let loBound = 0;
    let hiBound = arcTable.length - 1;
    while (loBound < hiBound - 1) {
      const mid = (loBound + hiBound) >> 1;
      if (arcTable[mid].t < refinedT) {
        loBound = mid;
      } else {
        hiBound = mid;
      }
    }
    const segT = arcTable[hiBound].t - arcTable[loBound].t;
    if (segT > 0) {
      const frac = (refinedT - arcTable[loBound].t) / segT;
      along = arcTable[loBound].distance + (arcTable[hiBound].distance - arcTable[loBound].distance) * frac;
    } else {
      along = arcTable[loBound].distance;
    }
  }

  const closestPt = evaluateSpline(spline, refinedT);
  const tan = tangentAtDistance(spline, along, arcTable);
  const norm: SplinePoint = { x: tan.z, z: -tan.x };

  const toPt = { x: point.x - closestPt.x, z: point.z - closestPt.z };
  const across = toPt.x * norm.x + toPt.z * norm.z;

  return { along, across };
}
