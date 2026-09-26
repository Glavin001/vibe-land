// What just broke, where, and how badly -- read off a topology message.
//
// The wire says which bonds broke and which islands were born; it never says
// where, or how much material let go. Both are in the manifest: a bond has a
// centroid in its structure's rest frame and an area, a chunk has a mass. This
// module joins the two into a short list of DUST SOURCES, one per cluster of
// nearby breaks, each with a world position, a magnitude and the velocity of
// the material that made it. The emission policy turns sources into clouds.
//
// Five kinds of event feed it:
//   fracture  bonds broke      -> where the bonds were, Σ area, a little
//   entry     the first break a shot made -> the near face, spall toward the shooter
//   shed      an island was born and is moving -> its centre of mass, its mass
//   impact    a body's velocity dropped sharply -> the contact, mass·Δv
//             (the settle is a fallback for a body no impact was seen on)
//   wave      many impacts in one place at once -> a collapse front
//
// Real dust is mostly crushing at impact, not cracks opening, and the
// impacts are read off the authoritative velocity stream: a body that was
// moving and suddenly is not hit something.
//
// Everything is O(events) with scratch typed arrays; nothing is allocated per
// message after warm-up, because a collapse produces a message every server
// tick for seconds on end.

import type { CityManifest, ManifestStructure } from './manifest';
import { bondEndpoints, bondGeometry } from './manifest';
import type { CityTopology } from './topology';
import { bodyKey } from './topology';
import type { TopologyMessage } from './wire';

export type DustSourceKind = 'fracture' | 'entry' | 'shed' | 'impact' | 'wave';

/** One clustered destruction event in world space. A pooled view: copy what you keep. */
export interface DustSource {
  kind: DustSourceKind;
  structureId: number;
  simTick: number;
  /** Rank within (structureId, simTick): with those two, the deterministic seed root. */
  ordinal: number;
  x: number;
  y: number;
  z: number;
  /** Outward face direction for a fracture (unit), zero otherwise. */
  nx: number;
  ny: number;
  nz: number;
  /** Mean velocity of the emitting material, m/s. */
  vx: number;
  vy: number;
  vz: number;
  /**
   * Dimensionless dust units. Fracture: 3·Σarea (≈0.5 per median bond;
   * a bond whose chunks stay together counts 15%). Entry: the fracture,
   * doubled. Shed: mass/500 (≈1 per median chunk). Impact: mass·|Δv|/4000
   * (≈1 per median chunk hitting the ground at 8 m/s). Wave: Σ impacts.
   */
  magnitude: number;
  /** Events folded into this source. */
  count: number;
  /** Material of the largest contributing bond, or 0. */
  material: number;
  /** When the source should be seen, on the performance.now() clock. */
  atMs: number;
}

/** What the extractor needs from the client, as closures so nothing allocates per call. */
export interface DustExtractContext {
  manifest: CityManifest;
  topology: CityTopology;
  structureById: Map<number, ManifestStructure>;
  /** Pre-fracture drawn pose of a promoted chunk, 7 floats at out[at..]. False if unknown. */
  drawnPoseInto(slot: number, out: Float32Array, at: number): boolean;
  /** Last presented speed of a body, m/s, 0 if it has no track. */
  presentedSpeed(key: number): number;
  /** Whether an impact was already raised for this body recently (so a settle need not). */
  impactedRecently?(key: number, nowMs: number): boolean;
  /** The shot a break at this point belongs to, if any. */
  matchShot?(x: number, y: number, z: number, nowMs: number): { ox: number; oy: number; oz: number } | null;
  /** performance.now() at the time of the message, for the quiet-cell memory. */
  nowMs?: number;
}

export interface DustExtractOptions {
  /** Bonds closer than this are one source. */
  cellSizeM: number;
  /** Largest sources kept per message. */
  maxSourcesPerMessage: number;
  /** An island coming to rest slower than this raises no dust. */
  minImpactSpeedMps: number;
  /** A born island slower than this is folded into its fracture instead of puffing on its own. */
  minShedSpeedMps: number;
  /** ...unless it is at least this heavy. */
  minShedMassKg: number;
}

export const DEFAULT_DUST_EXTRACT_OPTIONS: DustExtractOptions = {
  cellSizeM: 4,
  maxSourcesPerMessage: 32,
  minImpactSpeedMps: 3,
  minShedSpeedMps: 1,
  minShedMassKg: 5000,
};

/** A cell with no fracture for this long is quiet; the next break there may be an entry. */
const ENTRY_QUIET_MS = 1000;
/** How much a bond that broke without its chunks parting counts. */
const UNSEPARATED_WEIGHT = 0.15;

const MAX_CLUSTERS = 256;
const MAX_IMPACT_MEMBERS = 256;
const FRACTURE_UNITS_PER_M2 = 3;
const SHED_KG_PER_UNIT = 500;
const IMPACT_J_PER_UNIT = 5000;

const KIND_FRACTURE = 0;
const KIND_SHED = 1;
const KIND_IMPACT = 2;
const KIND_ENTRY = 3;
const KIND_WAVE = 4;
const KIND_NAMES: readonly DustSourceKind[] = ['fracture', 'shed', 'impact', 'entry', 'wave'];

/**
 * A ring of sources waiting for the frame. Several messages can apply between
 * two frames; the newest are dropped when it is full, because a burst's first
 * puff is the one that must not be lost.
 */
export class DustSourceQueue {
  readonly capacity: number;
  private readonly kind: Uint8Array;
  private readonly structureId: Uint32Array;
  private readonly simTick: Uint32Array;
  private readonly ordinal: Uint16Array;
  private readonly count: Uint32Array;
  private readonly material: Uint32Array;
  private readonly f: Float32Array;
  private readonly atMs: Float64Array;
  private head = 0;
  private length = 0;
  dropped = 0;
  private readonly view: DustSource = {
    kind: 'fracture', structureId: 0, simTick: 0, ordinal: 0, x: 0, y: 0, z: 0,
    nx: 0, ny: 0, nz: 0, vx: 0, vy: 0, vz: 0, magnitude: 0, count: 0, material: 0, atMs: 0,
  };

  constructor(capacity = 256, private readonly observe?: (source: DustSource) => void) {
    this.capacity = capacity;
    this.kind = new Uint8Array(capacity);
    this.structureId = new Uint32Array(capacity);
    this.simTick = new Uint32Array(capacity);
    this.ordinal = new Uint16Array(capacity);
    this.count = new Uint32Array(capacity);
    this.material = new Uint32Array(capacity);
    this.f = new Float32Array(capacity * 10);
    this.atMs = new Float64Array(capacity);
  }

  size(): number {
    return this.length;
  }

  push(s: DustSource): boolean {
    // Independent consumers (audio) must still see events when the visual
    // queue is full. They copy into their own bounded queues synchronously.
    this.observe?.(s);
    if (this.length >= this.capacity) {
      this.dropped += 1;
      return false;
    }
    const i = (this.head + this.length) % this.capacity;
    this.length += 1;
    this.kind[i] = KIND_NAMES.indexOf(s.kind);
    this.structureId[i] = s.structureId;
    this.simTick[i] = s.simTick;
    this.ordinal[i] = s.ordinal;
    this.count[i] = s.count;
    this.material[i] = s.material;
    this.atMs[i] = s.atMs;
    const b = i * 10;
    this.f[b] = s.x; this.f[b + 1] = s.y; this.f[b + 2] = s.z;
    this.f[b + 3] = s.nx; this.f[b + 4] = s.ny; this.f[b + 5] = s.nz;
    this.f[b + 6] = s.vx; this.f[b + 7] = s.vy; this.f[b + 8] = s.vz;
    this.f[b + 9] = s.magnitude;
    return true;
  }

  /** Visit every queued source, oldest first, then empty the queue. The view is reused. */
  drain(visit: (source: DustSource) => void): number {
    const n = this.length;
    for (let k = 0; k < n; k += 1) {
      const i = (this.head + k) % this.capacity;
      const v = this.view;
      v.kind = KIND_NAMES[this.kind[i]];
      v.structureId = this.structureId[i];
      v.simTick = this.simTick[i];
      v.ordinal = this.ordinal[i];
      v.count = this.count[i];
      v.material = this.material[i];
      v.atMs = this.atMs[i];
      const b = i * 10;
      v.x = this.f[b]; v.y = this.f[b + 1]; v.z = this.f[b + 2];
      v.nx = this.f[b + 3]; v.ny = this.f[b + 4]; v.nz = this.f[b + 5];
      v.vx = this.f[b + 6]; v.vy = this.f[b + 7]; v.vz = this.f[b + 8];
      v.magnitude = this.f[b + 9];
      visit(v);
    }
    this.head = (this.head + n) % this.capacity;
    this.length = 0;
    return n;
  }

  clear(): void {
    this.head = 0;
    this.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Scratch. One extractor runs at a time; these are module-level so a collapse
// that applies a message every tick never allocates.
// ---------------------------------------------------------------------------

const pose = new Float32Array(7);
const clusterKey = new Map<number, number>();
const nodeVelocity = new Map<number, number>(); // node -> promotion index within the batch
/** Per cluster: Σw·x, Σw·y, Σw·z, Σw, Σnx, Σny, Σnz, Σw·vx, Σw·vy, Σw·vz, magnitude, maxArea. */
const acc = new Float32Array(MAX_CLUSTERS * 12);
const accCount = new Uint32Array(MAX_CLUSTERS);
const accMaterial = new Uint32Array(MAX_CLUSTERS);
const accKind = new Uint8Array(MAX_CLUSTERS);
const accStructure = new Uint32Array(MAX_CLUSTERS);
const accCell = new Float64Array(MAX_CLUSTERS);
const accOrdinal = new Uint16Array(MAX_CLUSTERS);
const order = new Uint16Array(MAX_CLUSTERS);
const ranked = new Uint16Array(MAX_CLUSTERS);
/** Last fracture time per (structure, cell), for the entry test. */
const quietCells = new Map<number, number>();
const scratchSource: DustSource = {
  kind: 'fracture', structureId: 0, simTick: 0, ordinal: 0, x: 0, y: 0, z: 0,
  nx: 0, ny: 0, nz: 0, vx: 0, vy: 0, vz: 0, magnitude: 0, count: 0, material: 0, atMs: 0,
};
let clusters = 0;
let clustersOverflowed = 0;
let bondsUnresolved = 0;

export interface DustExtractStats {
  clustersOverflowed: number;
  bondsUnresolved: number;
  droppedByCap: number;
  entries: number;
}

const stats: DustExtractStats = { clustersOverflowed: 0, bondsUnresolved: 0, droppedByCap: 0, entries: 0 };

/** Cumulative counters, for the stats panel. */
export function dustExtractStats(): Readonly<DustExtractStats> {
  return stats;
}

function fold(v: number): number {
  return v >= 0 ? v * 2 : -v * 2 - 1;
}

/** A cell key unique per (structure, kind, cell). */
function cellKeyOf(structureId: number, kind: number, x: number, y: number, z: number, size: number): number {
  const cx = fold(Math.floor(x / size));
  const cy = fold(Math.floor(y / size));
  const cz = fold(Math.floor(z / size));
  // Spread into a double so three 20-bit cells and a structure id stay distinct.
  return (((structureId * 4 + kind) * 1048576 + cx) * 1048576 + cy) * 1048576 + cz;
}

function clusterFor(structureId: number, kind: number, key: number): number {
  const found = clusterKey.get(key);
  if (found !== undefined) return found;
  if (clusters >= MAX_CLUSTERS) {
    clustersOverflowed += 1;
    return clusters - 1;
  }
  const c = clusters;
  clusters += 1;
  clusterKey.set(key, c);
  acc.fill(0, c * 12, c * 12 + 12);
  accCount[c] = 0;
  accMaterial[c] = 0;
  accKind[c] = kind;
  accStructure[c] = structureId;
  accCell[c] = key;
  return c;
}

function accumulate(
  c: number, weight: number, x: number, y: number, z: number,
  nx: number, ny: number, nz: number, vx: number, vy: number, vz: number,
  magnitude: number, material: number,
): void {
  const b = c * 12;
  acc[b] += weight * x;
  acc[b + 1] += weight * y;
  acc[b + 2] += weight * z;
  acc[b + 3] += weight;
  acc[b + 4] += nx;
  acc[b + 5] += ny;
  acc[b + 6] += nz;
  acc[b + 7] += weight * vx;
  acc[b + 8] += weight * vy;
  acc[b + 9] += weight * vz;
  acc[b + 10] += magnitude;
  if (weight > acc[b + 11]) {
    acc[b + 11] = weight;
    accMaterial[c] = material;
  }
  accCount[c] += 1;
}

/**
 * World position of a bond, from whichever chunk is carrying it now.
 *
 * Every body in the ledger is a full transform from the structure's rest frame
 * (local rotation is identity everywhere, see CityTopology.reset and
 * adoptIslandMembersInner), so the bond's offset from its chunk's rest centroid
 * rotates with the chunk. This is exact for a bond on the standing building
 * and for one between two pieces of rubble that just hit each other.
 */
function bondWorldInto(
  ctx: DustExtractContext,
  structure: ManifestStructure,
  slot: number,
  bondIndex: number,
  centroid: Float32Array,
  normal: Float32Array,
  out: Float32Array,
  outNormal: Float32Array,
): boolean {
  const body = ctx.topology.body(ctx.topology.chunkBodyKey(slot));
  if (!ctx.drawnPoseInto(slot, pose, 0)) {
    if (!ctx.topology.chunkWorldPoseInto(slot, body, pose, 0)) return false;
  }
  const b = bondIndex * 3;
  const node = ctx.topology.chunkNode(slot);
  const rest = structure.chunks[node].centroid;
  const dx = centroid[b] - rest[0];
  const dy = centroid[b + 1] - rest[1];
  const dz = centroid[b + 2] - rest[2];
  const qx = pose[3];
  const qy = pose[4];
  const qz = pose[5];
  const qw = pose[6];
  const tx = 2 * (qy * dz - qz * dy);
  const ty = 2 * (qz * dx - qx * dz);
  const tz = 2 * (qx * dy - qy * dx);
  out[0] = pose[0] + dx + qw * tx + qy * tz - qz * ty;
  out[1] = pose[1] + dy + qw * ty + qz * tx - qx * tz;
  out[2] = pose[2] + dz + qw * tz + qx * ty - qy * tx;
  const nx = normal[b];
  const ny = normal[b + 1];
  const nz = normal[b + 2];
  const ux = 2 * (qy * nz - qz * ny);
  const uy = 2 * (qz * nx - qx * nz);
  const uz = 2 * (qx * ny - qy * nx);
  outNormal[0] = nx + qw * ux + qy * uz - qz * uy;
  outNormal[1] = ny + qw * uy + qz * ux - qx * uz;
  outNormal[2] = nz + qw * uz + qx * uy - qy * ux;
  return true;
}

const bondPos = new Float32Array(3);
const bondNormal = new Float32Array(3);

/**
 * Appends the message's sources to `out`, largest first. Returns how many.
 *
 * Call after `topology.apply(message)` (so born islands exist and can be
 * weighed) and before the settle loop closes their tracks (so an island's
 * last presented speed is still known).
 */
export function extractDustSources(
  message: TopologyMessage,
  ctx: DustExtractContext,
  out: DustSourceQueue,
  atMs: number,
  options: Partial<DustExtractOptions> = {},
): number {
  const opts = { ...DEFAULT_DUST_EXTRACT_OPTIONS, ...options };
  clusters = 0;
  clustersOverflowed = 0;
  bondsUnresolved = 0;
  clusterKey.clear();
  const { topology } = ctx;

  for (const batch of message.batches) {
    const structure = ctx.structureById.get(batch.structureId);
    if (!structure) continue;
    const { node0, node1 } = bondEndpoints(structure);
    const { centroid, normal, area, material } = bondGeometry(structure);

    nodeVelocity.clear();
    for (let p = 0; p < batch.promotions.length; p += 1) {
      for (const node of batch.promotions[p].nodes) nodeVelocity.set(node, p);
    }

    for (const bondIndex of batch.brokenBondIndices) {
      if (bondIndex >= node0.length) continue;
      const a = node0[bondIndex];
      const b = node1[bondIndex];
      let slot = topology.slotOf(batch.structureId, a);
      if (!bondWorldInto(ctx, structure, slot, bondIndex, centroid, normal, bondPos, bondNormal)) {
        slot = topology.slotOf(batch.structureId, b);
        if (!bondWorldInto(ctx, structure, slot, bondIndex, centroid, normal, bondPos, bondNormal)) {
          bondsUnresolved += 1;
          continue;
        }
      }
      let vx = 0;
      let vy = 0;
      let vz = 0;
      const moving = nodeVelocity.get(a) ?? nodeVelocity.get(b);
      if (moving !== undefined) {
        const v = batch.promotions[moving].linearVelocity;
        vx = v[0];
        vy = v[1];
        vz = v[2];
      }
      // A crack whose faces did not part makes little dust; separation is
      // the two endpoints now belonging to different bodies.
      const parted = topology.chunkBodyKey(topology.slotOf(batch.structureId, a))
        !== topology.chunkBodyKey(topology.slotOf(batch.structureId, b));
      const w = area[bondIndex] * (parted ? 1 : UNSEPARATED_WEIGHT);
      const key = cellKeyOf(batch.structureId, KIND_FRACTURE, bondPos[0], bondPos[1], bondPos[2], opts.cellSizeM);
      const c = clusterFor(batch.structureId, KIND_FRACTURE, key);
      accumulate(
        c, w, bondPos[0], bondPos[1], bondPos[2],
        bondNormal[0], bondNormal[1], bondNormal[2], vx, vy, vz,
        w * FRACTURE_UNITS_PER_M2, material[bondIndex],
      );
    }

    for (const promotion of batch.promotions) {
      let mass = 0;
      for (const node of promotion.nodes) {
        mass += topology.restMassOf(topology.slotOf(batch.structureId, node));
      }
      const v = promotion.linearVelocity;
      const speed = Math.hypot(v[0], v[1], v[2]);
      const units = mass / SHED_KG_PER_UNIT;
      const p = promotion.position;
      if (speed >= opts.minShedSpeedMps || mass >= opts.minShedMassKg) {
        const key = cellKeyOf(batch.structureId, KIND_SHED, p[0], p[1], p[2], opts.cellSizeM);
        const c = clusterFor(batch.structureId, KIND_SHED, key);
        accumulate(c, mass, p[0], p[1], p[2], 0, 0, 0, v[0], v[1], v[2], units, 0);
      } else {
        // Static fracture: the bonds around it already made a source; give it
        // a little of the island's mass rather than a second puff.
        const key = cellKeyOf(batch.structureId, KIND_FRACTURE, p[0], p[1], p[2], opts.cellSizeM);
        const c = clusterKey.get(key);
        if (c !== undefined) acc[c * 12 + 10] += units * 0.25;
      }
    }
  }

  for (const settle of message.settled) {
    const key = bodyKey(settle.structureId, settle.islandId);
    // The velocity stream usually saw the impact already; the settle is the
    // fallback for a body it did not (a starved track, wire v3 sampling).
    if (ctx.impactedRecently?.(key, atMs)) continue;
    const speed = ctx.presentedSpeed(key);
    if (speed < opts.minImpactSpeedMps) continue;
    const body = topology.body(key);
    if (!body) continue;
    const members = body.chunkSlots;
    const scanned = Math.min(members.length, MAX_IMPACT_MEMBERS);
    let mass = 0;
    for (let i = 0; i < scanned; i += 1) mass += topology.restMassOf(members[i]);
    if (scanned < members.length) mass *= members.length / scanned;
    const units = (0.5 * mass * speed * speed) / IMPACT_J_PER_UNIT;
    const p = settle.position;
    // Rubble lands on the street: put the puff at ground when the body is
    // low, and a metre under its centre otherwise (a slab on a roof).
    const y = p[1] < 3 ? 0.3 : Math.max(0.3, p[1] - 1);
    const cell = cellKeyOf(settle.structureId, KIND_IMPACT, p[0], y, p[2], opts.cellSizeM);
    const c = clusterFor(settle.structureId, KIND_IMPACT, cell);
    accumulate(c, mass, p[0], y, p[2], 0, 0, 0, 0, 0, 0, units, 0);
  }

  // Ordinals: rank by cell key within the structure, fixed before the cap so
  // the same message always numbers its sources the same way.
  for (let c = 0; c < clusters; c += 1) order[c] = c;
  const ordered = order.subarray(0, clusters);
  ordered.sort((i, j) => (accStructure[i] - accStructure[j]) || (accCell[i] - accCell[j]));
  let previousStructure = -1;
  let ordinal = 0;
  for (let k = 0; k < clusters; k += 1) {
    const c = ordered[k];
    if (accStructure[c] !== previousStructure) {
      previousStructure = accStructure[c];
      ordinal = 0;
    }
    accOrdinal[c] = ordinal;
    ordinal += 1;
  }

  // Largest first, capped.
  for (let c = 0; c < clusters; c += 1) ranked[c] = c;
  const kept = ranked.subarray(0, clusters);
  kept.sort((i, j) => acc[j * 12 + 10] - acc[i * 12 + 10]);
  const keep = Math.min(clusters, opts.maxSourcesPerMessage);
  stats.droppedByCap += clusters - keep;
  stats.clustersOverflowed += clustersOverflowed;
  stats.bondsUnresolved += bondsUnresolved;

  let pushed = 0;
  const nowMs = ctx.nowMs ?? atMs;
  for (let k = 0; k < keep; k += 1) {
    const c = kept[k];
    const b = c * 12;
    const w = acc[b + 3];
    if (!(w > 0)) continue;
    const x = acc[b] / w;
    const y = acc[b + 1] / w;
    const z = acc[b + 2] / w;
    let nx = acc[b + 4];
    let ny = acc[b + 5];
    let nz = acc[b + 6];
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-6) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
    }
    let kind = accKind[c];
    let magnitude = acc[b + 10];
    if (kind === KIND_FRACTURE) {
      // The first break in a quiet cell along a shot's path is that shot
      // landing: spall on the near face, thrown back toward the shooter.
      const quietKey = accCell[c];
      const lastMs = quietCells.get(quietKey);
      quietCells.set(quietKey, nowMs);
      if (quietCells.size > 4096) {
        for (const [key, at] of quietCells) {
          if (nowMs - at > ENTRY_QUIET_MS) quietCells.delete(key);
        }
      }
      if (lastMs === undefined || nowMs - lastMs > ENTRY_QUIET_MS) {
        const shot = ctx.matchShot?.(x, y, z, nowMs);
        if (shot) {
          kind = KIND_ENTRY;
          magnitude *= 2;
          stats.entries += 1;
          const tx = shot.ox - x;
          const ty = shot.oy - y;
          const tz = shot.oz - z;
          const tl = Math.hypot(tx, ty, tz) || 1;
          // Face the shooter, tilted by the bond normal so the puff hugs the wall.
          nx = tx / tl + nx * 0.5;
          ny = ty / tl + ny * 0.5;
          nz = tz / tl + nz * 0.5;
          const l2 = Math.hypot(nx, ny, nz) || 1;
          nx /= l2;
          ny /= l2;
          nz /= l2;
        }
      }
    }
    const s = scratchSource;
    s.kind = KIND_NAMES[kind];
    s.structureId = accStructure[c];
    s.simTick = message.simTick;
    s.ordinal = accOrdinal[c];
    s.x = x;
    s.y = y;
    s.z = z;
    s.nx = nx;
    s.ny = ny;
    s.nz = nz;
    s.vx = acc[b + 7] / w;
    s.vy = acc[b + 8] / w;
    s.vz = acc[b + 9] / w;
    s.magnitude = magnitude;
    s.count = accCount[c];
    s.material = accMaterial[c];
    s.atMs = atMs;
    if (out.push(s)) pushed += 1;
  }
  return pushed;
}
