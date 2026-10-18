/**
 * Does the city DRAW each chunk as the shape physics COLLIDES with?
 *
 *   node tools/verify-hulls.mjs [manifest.json]
 *
 * The two could in principle disagree, because the pack ships `nodeMeshes`
 * (authored render prisms) alongside `nodeColliders` (convex hulls) and the
 * Rust loader parses only the colliders -- the client then rebuilds a render
 * mesh from the collider points with ConvexGeometry. That is the right call
 * (one source of truth beats two that can drift), but "right by construction"
 * is a claim, and this checks it.
 *
 * Per hull chunk:
 *   1. point count <= 64, the limit PhysX cooks GPU convex meshes from
 *      (MAX_HULL_POINTS in the exporter). Over it, physics silently gets a
 *      DIFFERENT shape from the one authored -- the exact corruption to rule out.
 *   2. every drawn vertex is one of the collider's own points, to 1e-4 m: the
 *      renderer invents no geometry.
 *   3. every collider point lies on or inside the drawn hull: the renderer
 *      drops none of it. Points strictly inside are legitimately not hull
 *      vertices; physics discards them too, so agreement is what matters.
 *   4. the drawn AABB equals the collider's AABB.
 *   5. the drawn solid is closed (every edge shared by exactly two triangles),
 *      because an open mesh has no well-defined inside to compare against.
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

const MANIFEST = process.argv[2] ?? '/tmp/city-manifest.json';
/** PhysX cooks GPU convex meshes from at most this many vertices. */
const MAX_HULL_POINTS = 64;
/** Positions are rounded when the pack is written; well below a millimetre. */
const EPS_M = 1e-4;
/** Tolerance for "inside the hull", in metres. */
const EPS_INSIDE_M = 1e-3;

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

function isHull(geometry) {
  return geometry
    && (geometry.kind === 'convexHull' || geometry.kind === 'convex_hull')
    && Array.isArray(geometry.points)
    && geometry.points.length % 3 === 0
    && geometry.points.length / 3 >= 4;
}

/** Face planes of a closed triangle mesh, outward-oriented. */
function facePlanes(position, index) {
  const planes = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const count = index ? index.count : position.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    ab.subVectors(b, a); ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-20) continue;
    n.normalize();
    planes.push({ nx: n.x, ny: n.y, nz: n.z, d: n.dot(a) });
  }
  return planes;
}

/** Every edge of a closed solid is shared by exactly two triangles. */
function isClosed(position, index) {
  const count = index ? index.count : position.count;
  const key = (i, j) => (i < j ? `${i}_${j}` : `${j}_${i}`);
  // Weld by position: ConvexGeometry emits per-face vertices, so index
  // identity alone would report every edge as unshared.
  const idOf = new Map();
  const vid = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i);
    const k = `${Math.round(v.x / EPS_M)},${Math.round(v.y / EPS_M)},${Math.round(v.z / EPS_M)}`;
    if (!idOf.has(k)) idOf.set(k, idOf.size);
    vid[i] = idOf.get(k);
  }
  const edges = new Map();
  for (let i = 0; i + 2 < count; i += 3) {
    const t = [0, 1, 2].map((o) => vid[index ? index.getX(i + o) : i + o]);
    for (let e = 0; e < 3; e += 1) {
      const k = key(t[e], t[(e + 1) % 3]);
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  for (const n of edges.values()) if (n !== 2) return false;
  return true;
}

const fail = { overPoints: [], invented: [], dropped: [], aabb: [], open: [], degenerate: [] };
let hulls = 0, boxes = 0, maxPoints = 0, maxDrawnVerts = 0;

for (const structure of manifest.structures) {
  for (const chunk of structure.chunks) {
    if (!isHull(chunk.geometry)) { boxes += 1; continue; }
    hulls += 1;
    const raw = chunk.geometry.points;
    const pointCount = raw.length / 3;
    maxPoints = Math.max(maxPoints, pointCount);
    const id = `${structure.structureId}/${chunk.nodeIndex}`;
    if (pointCount > MAX_HULL_POINTS) fail.overPoints.push(`${id}: ${pointCount} points`);

    const points = [];
    for (let i = 0; i < raw.length; i += 3) points.push(new THREE.Vector3(raw[i], raw[i + 1], raw[i + 2]));

    let geometry;
    try {
      geometry = new ConvexGeometry(points);
    } catch (error) {
      fail.degenerate.push(`${id}: ${String(error).slice(0, 80)}`);
      continue;
    }
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!position || position.count === 0) { fail.degenerate.push(`${id}: empty geometry`); continue; }
    maxDrawnVerts = Math.max(maxDrawnVerts, position.count);

    if (!isClosed(position, index)) fail.open.push(id);

    // 2. No invented vertices: every drawn position is a collider point.
    const drawn = new THREE.Vector3();
    let invented = 0;
    for (let i = 0; i < position.count; i += 1) {
      drawn.fromBufferAttribute(position, i);
      if (!points.some((p) => p.distanceTo(drawn) <= EPS_M)) invented += 1;
    }
    if (invented > 0) fail.invented.push(`${id}: ${invented} drawn vertices are not collider points`);

    // 3. Nothing dropped: every collider point is on or inside the drawn hull.
    const planes = facePlanes(position, index);
    let outside = 0;
    for (const p of points) {
      for (const pl of planes) {
        if (pl.nx * p.x + pl.ny * p.y + pl.nz * p.z - pl.d > EPS_INSIDE_M) { outside += 1; break; }
      }
    }
    if (outside > 0) fail.dropped.push(`${id}: ${outside} collider points outside the drawn hull`);

    // 4. Same bounding box.
    geometry.computeBoundingBox();
    const box = new THREE.Box3().setFromPoints(points);
    const d = Math.max(
      geometry.boundingBox.min.distanceTo(box.min),
      geometry.boundingBox.max.distanceTo(box.max),
    );
    if (d > EPS_M) fail.aabb.push(`${id}: AABB differs by ${d.toFixed(5)} m`);
    geometry.dispose();
  }
}

console.log(`manifest ${MANIFEST}`);
console.log(`  chunks: ${hulls} hulls, ${boxes} boxes`);
console.log(`  collider points per hull: max ${maxPoints} (limit ${MAX_HULL_POINTS})`);
console.log(`  drawn vertices per hull:  max ${maxDrawnVerts}`);
let failed = 0;
for (const [name, list] of Object.entries(fail)) {
  console.log(`  ${name.padEnd(11)} ${list.length === 0 ? 'ok' : `FAIL (${list.length})`}`);
  for (const line of list.slice(0, 5)) console.log(`      ${line}`);
  failed += list.length;
}
process.exit(failed === 0 ? 0 : 1);
