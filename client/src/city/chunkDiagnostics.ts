import type { CityE2EStats } from '../e2eBridge';
import type { CityTopology } from './topology';

/** Shared threshold for both the count and the corresponding pose evidence. */
export const CHUNK_SUNK_Y_M = -0.25;

/** Snapshot the composition inputs; never retain mutable ledger arrays. */
export function deepestChunkProvenance(
  topology: CityTopology,
  slot: number,
  positions: Float32Array,
): CityE2EStats['deepest'] {
  if (slot < 0 || slot >= topology.chunkCount) return null;
  const at = slot * 3;
  const worldY = positions[at + 1];
  if (!Number.isFinite(worldY) || worldY >= CHUNK_SUNK_Y_M) return null;
  const key = topology.bodyKeyOf(slot);
  const body = topology.body(key);
  // An unresolved local offset is not a world pose. The sweep reports missing
  // poses separately, rather than diagnosing them as ground penetration.
  if (!body) return null;
  const local = topology.chunkLocalOffset(slot);
  const source = topology.watchPoseSources ? topology.poseSourceOf(key).source : undefined;
  return {
    slot,
    structure: topology.chunkStructure(slot),
    node: topology.chunkNode(slot),
    worldY,
    worldPosition: [positions[at], worldY, positions[at + 2]],
    islandSerial: body.islandSerial,
    bodyKey: key,
    bodyPos: [body.position[0], body.position[1], body.position[2]],
    bodyRotation: [body.rotation[0], body.rotation[1], body.rotation[2], body.rotation[3]],
    bodyMembers: body.chunkSlots.length,
    settled: body.settled,
    localOffset: [local.position[0], local.position[1], local.position[2]],
    localRotation: [local.rotation[0], local.rotation[1], local.rotation[2], local.rotation[3]],
    topologySeq: topology.lastSeq(),
    poseSourceTracking: topology.watchPoseSources,
    poseSource: source ?? null,
  };
}

/** Compare against the already composed sweep, without a second ledger walk. */
export function compareDrawnChunkPositions(
  positions: Float32Array,
  previous: Float32Array,
  chunkCount: number,
  toleranceM: number,
): { checked: number; stale: number } {
  let checked = 0;
  let stale = 0;
  const count = Math.min(chunkCount, Math.floor(positions.length / 3), Math.floor(previous.length / 3));
  for (let slot = 0; slot < count; slot += 1) {
    const at = slot * 3;
    const x = positions[at], y = positions[at + 1], z = positions[at + 2];
    const px = previous[at], py = previous[at + 1], pz = previous[at + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
      || !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
    checked += 1;
    if (Math.hypot(x - px, y - py, z - pz) > toleranceM) stale += 1;
  }
  return { checked, stale };
}
