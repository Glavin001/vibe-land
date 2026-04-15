/**
 * Vehicle-aware navcat {@link QueryFilter}.
 *
 * Unlike `DEFAULT_QUERY_FILTER` (which costs an edge solely by Euclidean
 * distance), this filter adds a **turn penalty** derived from the agent's
 * minimum turning radius. A path that threads a sharp right-angle corner
 * is heavily discouraged vs. a gentle curve the chassis can physically
 * execute at cruise speed.
 *
 * The filter is attached to vehicle-mode agents via `AgentParams.queryFilter`
 * in {@link BotCrowd}. Foot agents continue to use `DEFAULT_QUERY_FILTER`.
 *
 * ## How the turn penalty works
 *
 * For each A* edge call, navcat passes `(pa, pb, navMesh, prevRef, curRef,
 * nextRef)` where `pa` is the portal crossing from the previous node into
 * the current node, and `pb` is the portal crossing out of the current
 * node toward the next node. We approximate the local path direction
 * change by:
 *
 *   in  = centroid(curRef) - pa
 *   out = pb - centroid(curRef)
 *
 * and compute the angle θ between those two. We then estimate the radius
 * of the arc the vehicle would have to sweep through the node from the
 * classic chord formula:
 *
 *   requiredRadius ≈ segmentLen / (2 · sin(θ/2))
 *
 * where `segmentLen = |in| + |out|`. If `requiredRadius < turningRadius`,
 * the edge gets a large penalty so A* routes around that corner. Gentle
 * curves (small θ) get a very small penalty; straight segments cost
 * exactly `|pb - pa|`, matching `DEFAULT_QUERY_FILTER` so the planner
 * still produces sensible distance-first paths on open terrain.
 */

import {
  DEFAULT_QUERY_FILTER,
  getTileAndPolyByRef,
  type NavMesh,
  type NodeRef,
  type QueryFilter,
  type Vec3,
} from 'navcat';

import type { VehicleProfile } from '../types';

/** Hard failure threshold applied to corners the vehicle can't physically take. */
export const TIGHT_TURN_PENALTY_SCALE = 100;
export const TIGHT_TURN_PENALTY_BIAS = 50;
/** Mild preference for smoother paths on tractable corners. */
export const SOFT_TURN_WEIGHT = 0.3;

/**
 * Core of the turn-aware A* cost, broken out as a pure function for
 * unit-test access. Given the portal crossing positions (`pa` into the
 * current node, `pb` out) and the centroid of the current node, returns
 * the cost A* should apply to the edge.
 *
 * All positions are 3D world-space; turn angle is measured in the XZ
 * plane (Y is up).
 */
export function computeTurnAwareCost(
  pa: readonly [number, number, number],
  pb: readonly [number, number, number],
  center: readonly [number, number, number],
  turningRadius: number,
): number {
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  const dz = pb[2] - pa[2];
  const baseCost = Math.hypot(dx, dy, dz);

  const inx = center[0] - pa[0];
  const inz = center[2] - pa[2];
  const outx = pb[0] - center[0];
  const outz = pb[2] - center[2];
  const inLen = Math.hypot(inx, inz);
  const outLen = Math.hypot(outx, outz);
  if (inLen < 1e-4 || outLen < 1e-4) return baseCost;

  const cosTheta = (inx * outx + inz * outz) / (inLen * outLen);
  const clamped = cosTheta < -1 ? -1 : cosTheta > 1 ? 1 : cosTheta;
  const theta = Math.acos(clamped); // 0..π

  const halfTheta = theta * 0.5;
  const sinHalf = Math.sin(halfTheta);
  if (sinHalf < 1e-4) return baseCost; // straight segment

  const segmentLen = inLen + outLen;
  const requiredRadius = segmentLen / (2 * sinHalf);

  if (requiredRadius < turningRadius) {
    return baseCost * TIGHT_TURN_PENALTY_SCALE + TIGHT_TURN_PENALTY_BIAS;
  }
  return baseCost * (1 + SOFT_TURN_WEIGHT * (theta / Math.PI));
}

/**
 * Builds a `QueryFilter` suitable for a vehicle-mode crowd agent. The
 * returned filter closes over `profile.turningRadius` — pass a fresh one
 * if the profile changes.
 */
export function createVehicleQueryFilter(profile: VehicleProfile): QueryFilter {
  return {
    passFilter(nodeRef: NodeRef, navMesh: NavMesh): boolean {
      // Delegate area/flag checks to the default filter. The vehicle
      // navmesh was built with a larger walkable-radius erosion, so the
      // narrow passages are already absent from the tile set — we don't
      // need a second layer of area filtering here.
      return DEFAULT_QUERY_FILTER.passFilter(nodeRef, navMesh);
    },
    getCost(
      pa: Vec3,
      pb: Vec3,
      navMesh: NavMesh,
      prevRef: NodeRef | undefined,
      curRef: NodeRef,
      nextRef: NodeRef | undefined,
    ): number {
      const baseCost = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
      // Edge of the corridor (start or end): no turn context available.
      if (prevRef === undefined || nextRef === undefined) return baseCost;
      const center = getPolyCentroid(navMesh, curRef);
      if (!center) return baseCost;
      return computeTurnAwareCost(pa, pb, center, profile.turningRadius);
    },
  };
}

/** Computes the XZ-plane centroid of a polygon given its node reference. */
function getPolyCentroid(navMesh: NavMesh, ref: NodeRef): Vec3 | null {
  const result = getTileAndPolyByRef(ref, navMesh);
  if (!result.success) return null;
  const { tile, poly } = result;
  const vertexIndices = poly.vertices;
  const count = vertexIndices.length;
  if (count === 0) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i += 1) {
    const base = vertexIndices[i] * 3;
    cx += tile.vertices[base];
    cy += tile.vertices[base + 1];
    cz += tile.vertices[base + 2];
  }
  const inv = 1 / count;
  return [cx * inv, cy * inv, cz * inv] as Vec3;
}
