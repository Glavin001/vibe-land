// Render geometry for destructible chunks.
//
// The manifest already describes every chunk's true shape -- fractured pieces
// are convex hulls, structural members are boxes -- but the renderer used to
// draw all of them as a scaled unit cube, so a Voronoi shard read as a box
// that visibly overlapped its neighbours. This module turns a manifest chunk
// into what the renderer needs, and is deliberately separate from the React
// layer so the shape decisions can be unit tested without a WebGL context.
//
// Hull points are centroid-relative, the same frame the chunk's body-local
// offset is expressed in, so a hull geometry needs no recentering: it drops
// straight into the transform slot the unit cube used to occupy.

import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

import type { ManifestChunk } from './manifest';
import { cuboidHalfExtents, isConvexHullGeometry } from './manifest';

/**
 * Degenerate chunks would collapse the mesh, so boxes get a floor. Well below
 * anything authored; only guards against a zero or missing size.
 */
const MIN_BOX_EXTENT_M = 0.05;

/** A hull needs four non-coplanar points before it encloses any volume. */
export const MIN_HULL_POINTS = 4;

export type ChunkShape =
  | { kind: 'box'; scale: [number, number, number] }
  /**
   * `key` is shared by every chunk with identical points. The city stamps one
   * building pack many times, so the same shard recurs once per instance --
   * deduplicating on this turns thousands of hulls into hundreds of uploads.
   */
  | { kind: 'hull'; key: string; points: Float32Array };

/**
 * What to draw for this chunk.
 *
 * Falls back to a box whenever hull points are unusable rather than throwing:
 * a single malformed chunk should cost one chunk's fidelity, not the whole
 * city's mesh. `chunk.size` is the authored AABB, so the fallback still lands
 * in roughly the right place.
 */
export function chunkShape(chunk: ManifestChunk): ChunkShape {
  const geometry = chunk.geometry;
  if (geometry && isConvexHullGeometry(geometry)) {
    const points = geometry.points;
    if (Array.isArray(points) && points.length % 3 === 0 && points.length / 3 >= MIN_HULL_POINTS) {
      const typed = Float32Array.from(points);
      if (typed.every(Number.isFinite)) {
        // Prefer the id the pack states over one derived from the points.
        // Deriving identity means hashing every shard at load to rediscover
        // what the fracturer already knew, and it makes shape equality depend
        // on float rounding surviving a JSON round-trip. `hullKey` stays for
        // packs authored without a shape library.
        const id = geometry.shapeId;
        return {
          kind: 'hull',
          key: id === undefined ? hullKey(typed) : `s${id}`,
          points: typed,
        };
      }
    }
  }
  return { kind: 'box', scale: boxScale(chunk) };
}

/** Authored AABB, floored so a missing or zero extent cannot collapse a box. */
export function boxScale(chunk: ManifestChunk): [number, number, number] {
  const size = chunk.size;
  const extents = size ?? cuboidHalfExtents(chunk.geometry)?.map((half) => half * 2);
  return [
    Math.max(MIN_BOX_EXTENT_M, extents?.[0] ?? 0),
    Math.max(MIN_BOX_EXTENT_M, extents?.[1] ?? 0),
    Math.max(MIN_BOX_EXTENT_M, extents?.[2] ?? 0),
  ];
}

/**
 * Identity of a hull's point set.
 *
 * Rounded to a tenth of a millimetre so two shards that are the same shape
 * survive a float round-trip through JSON as one geometry, and joined with a
 * separator so `[1, 23]` and `[12, 3]` cannot collide.
 *
 * Canonical rather than literal: the distinct points, sorted. What is drawn is
 * the CONVEX HULL of these points, and that depends only on the set -- so two
 * arrays holding the same points in a different order, or with different
 * duplicates, are the same solid and must share one geometry.
 *
 * Both cases are real and common in the packs:
 *
 * - `nodeColliders` reuses the render prism's positions, which repeat every
 *   vertex three times so faces can carry flat normals. Measured on downtown:
 *   exactly 3.00x redundancy on all 7,160 hulls, 18-54 stored points for a
 *   6-18 point solid.
 * - A wall's four faces bake their orientation into the points, and the +/-
 *   facing pair differs only by the sign of the thickness axis -- the same set,
 *   walked in a different order. Literal keying saw those as two shapes and
 *   duplicated every one: 320 keys for 160 distinct solids at SHARD_PATTERNS=2.
 */
export function hullKey(points: Float32Array): string {
  const distinct = new Set<string>();
  for (let i = 0; i + 2 < points.length; i += 3) {
    distinct.add(
      `${Math.round(points[i] * 1e4)},${Math.round(points[i + 1] * 1e4)},`
      + `${Math.round(points[i + 2] * 1e4)}`,
    );
  }
  return [...distinct].sort().join(';');
}

/**
 * Triangulated hull for a point set.
 *
 * The points are already convex (fracture cells are convex by construction),
 * but they arrive as an unordered cloud with no face information, so the hull
 * still has to be computed to know which triangles to emit.
 */
export function buildHullGeometry(points: Float32Array): THREE.BufferGeometry {
  const vertices: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    vertices.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  }
  return normalizeForBatching(new ConvexGeometry(vertices));
}

/** Unit cube, in the same layout hulls are normalised to. */
export function buildBoxGeometry(): THREE.BufferGeometry {
  return normalizeForBatching(new THREE.BoxGeometry(1, 1, 1));
}

/**
 * Give a geometry the exact attribute layout batched rendering requires.
 *
 * Geometries drawn from one batch share a single buffer, so they must agree on
 * whether they are indexed and on which attributes they carry -- a mismatch is
 * a hard error, not a silent fallback, and takes the whole mesh with it.
 * `BoxGeometry` arrives indexed and UV-mapped while a computed hull is neither,
 * so both are normalised to the same shape rather than trusting them to match.
 *
 * Anything missing is synthesised: a sequential index for non-indexed
 * geometry, and zeroed UVs. The UVs stay zeroed and stay unread -- the city is
 * textured by projection from each chunk's rest pose rather than by UV, because
 * a hull arrives as an unordered point cloud with no UVs to preserve and one
 * geometry is shared by thousands of chunks. They exist only so the layouts
 * line up.
 *
 * `cityAnchor` is the rest-pose position the projection is anchored to. It is
 * created empty here and filled per instance by `bakeRestAnchors` on the
 * batched path, or overwritten wholesale by an InstancedBufferAttribute of the
 * same name on the instanced one. Either way every geometry entering a batch
 * has to carry it, which is why it is minted here rather than at either use.
 */
export function normalizeForBatching(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  const vertexCount = geometry.getAttribute('position').count;
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
  }
  if (!geometry.getAttribute('cityAnchor')) {
    geometry.setAttribute(
      'cityAnchor',
      new THREE.BufferAttribute(new Float32Array(vertexCount * 4), 4),
    );
  }
  if (!geometry.getIndex()) {
    const index = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      index[i] = i;
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }
  return geometry;
}
