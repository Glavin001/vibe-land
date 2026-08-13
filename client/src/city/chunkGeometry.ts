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
        return { kind: 'hull', key: hullKey(typed), points: typed };
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
 */
export function hullKey(points: Float32Array): string {
  let key = '';
  for (let i = 0; i < points.length; i++) {
    key += `${Math.round(points[i] * 1e4)},`;
  }
  return key;
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
  return new ConvexGeometry(vertices);
}
